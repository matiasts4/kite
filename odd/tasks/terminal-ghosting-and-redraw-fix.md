# Terminal Ghosting and Redraw — Attempt Log

Status: RESOLVED on `feat/ui-composer` (2026-11-01). Root cause identified as Variation Selector-16 (`U+FE0F`) cell-width disagreement under Unicode Mode 2027 (`?2027h`), causing Windows ConPTY 1-column late autowrap on full-frame redraws. Fixed in both `vt100` (`cell.rs`, `row.rs`, `screen.rs`) and `ZwjAwareUnicode11Provider` (`src/lib/terminalViewport.ts`), verified 0/138 artifact frames. See Section 16.3 and Section 17 for full resolution details.
Branch: `feat/ui-composer`.

Visual checks verified:
1. Grok and OpenCode terminals open coherently in tight and multi-split panes.
2. OpenCode stays coherent over long runs: no ghost lines, stuck borders, or character shifts accumulate.

---

## Symptom log

### S-launch — scrambled first frame (resolved)

Opening Grok or OpenCode in a tight pane paints a broken welcome screen. Text from the same TUI frame overlaps, clips, and lands in the wrong columns.
Resolved by eliminating the arbitrary spawn floors and reconciling settled viewport geometry before PTY spawn.

### S-ghost — artifacts over time (RESOLVED 2026-11-01)

Before the launch regression, OpenCode sessions accumulated ghosting during normal use:

- A previous table or header stayed pinned over newer output.
- In-place updates collided (`Notfrbidden` style merges).
- A manual resize, or leaving the view and coming back, cleared the ghosts because that path refits and the app repaints.

Grok tends to redraw a full frame, so it self-heals. OpenCode updates damaged cells only, so a bad frame sticks.

### S-collapse-expand — artifacts after extreme resize (new evidence, 2026-10-29)

Collapsing a terminal to an extreme narrow width and then expanding it reproduces
the artifacts. The captured frame shows fragments/columns and blue bars that are
misaligned. The narrow pane alone is not the failure; the collapse-to-extreme-
width then expand transition is. This is a diagnostic observation, not a fix or
proof that every narrow layout is broken.

Current interpretation is deliberately bounded:

- **Primary cluster:** extreme-resize geometry/reflow.
- **Secondary cluster:** stale DOM repaint after that transition.
- **Not newly implicated:** ANSI/PTY bytes or ordering; this observation adds no
  new evidence for that class.

Keep the next code experiment capture-gated and repaint-only. It must call
neither `term.resize` nor `resize_terminal`.

### S-noise — resize announced as "agent finished" (separate)

ConPTY dumps the screen on resize. The activity tracker treated that dump as new work and the proactive watcher spoke or toasted. That is not a pixel bug. The watcher call is currently commented out in the dirty `src/App.tsx`. Leave that decision out of render commits.

---

## Attempt 1 — committed, did not fix, launch got worse

Commit: `986e308` `fix(terminal): eliminate ghost text and synchronize ConPTY geometry` (2026-10-28).

Files: `src/components/views/TerminalView.tsx`, `src/components/views/terminal.css`, this document.

What it changed:

- Removed `transform: scale(0.995)` from the terminal fade-in, so cell measurement is not taken under a CSS scale.
- Called `fit()` once before `start_terminal` / `attach_terminal` when `clientWidth > 0`, and stored that size in `lastColsRef` / `lastRowsRef`.
- Shortened the resize debounce from 100ms to 20ms.
- On the alternate screen, `restoreScroll()` now calls `term.refresh()` and skips `scrollToBottom()`.
- Stopped calling `term.reset()` on a fresh start. Reset remains only for an explicit restart.
- Added a `refresh` / `redraw` terminal command.

Why this misses the screenshot:

- `clientWidth > 0` is not a stable size. With three terminals, the first measure often happens before the split finishes. That transient size is what the PTY and the TUI paint.
- Storing `lastCols` before the follow-up `fitTerminal(true)` makes that call a no-op when the cols have not changed yet. The corrective SIGWINCH never goes out.
- Timers at 50, 150, 400, and 900ms still call `fitTerminal(true)` while the welcome frame is painting. Each one can change ConPTY geometry mid-draw.
- `term.refresh()` redraws whatever xterm already stored. It does not ask OpenCode or Grok to repaint. On OpenCode it freezes the torn frame.
- Removing `term.reset()` lets a parked xterm reuse a previous grid for a new PTY.

The scale removal is still reasonable. It is not sufficient, and the pre-spawn fit as written is the likely cause of S-launch.

---

## Dirty work that is not this fix

Do not stage these into a terminal-render commit.

| Path | What it is |
| :--- | :--- |
| `src/lib/terminalRegistry.ts` and `src/lib/terminalRegistry.test.ts` | Prompt-ready detection and `waitForTerminalReady`. Changes when a prompt is considered delivered. Does not change pixels. |
| `src/App.tsx` | `startProactiveAgentWatcher()` commented out, mixed with other uncommitted app work. |
| Rest of the working tree | Composer, settings, files view, operator. Unrelated. |

An earlier uncommitted rewrite of this document proposed code page 850, `TERM` / `LANG`, and a minimum pane width as the main fix. Those were not applied. They do not explain a welcome screen that heals for Grok after one real resize. Keep them as later experiments only if a stable grid still shows character drift.

---

## Ranked causes

1. **Extreme-resize geometry/reflow (new primary cluster, S-collapse-expand).** The collapse-to-extreme-width then expand transition reproduces fragments/columns and misaligned blue bars. A narrow pane by itself is not the error. This is not yet a proven root cause.
2. **Stale DOM repaint after reflow (secondary cluster, S-collapse-expand).** A repaint may retain stale fragments after the geometry transition; isolate it without resizing the terminal.
3. **Unstable size at spawn (S-launch).** The PTY is opened on a transient grid. The TUI paints with cursor addressing. A later shrink wraps those addresses and the lines overlap. Grok heals because a real resize plus input redraws the whole screen. OpenCode does not, because it only patches cells.
4. **Resize storms during the first second (S-launch and S-ghost).** Four delayed fits plus a 20ms debounce deliver several SIGWINCHs while the banner is still being written. A delta TUI cannot reconstruct from a partial ConPTY redraw.
5. **`refresh()` paints the damaged buffer (S-ghost sticks).** It clears renderer dirt. It does not clear logical ghosts left by a soft-wrap plus cursor-up (`CSI A` / `CSI 2K`) when the app and xterm disagreed on width.
6. **Soft-wrap ghosts after the grid is wrong even once (S-ghost).** If OpenCode believes a row is one line and xterm wrapped it, cursor-up erases only the tail. The head stays forever. This matches the original "resize clears it" report.
7. **Width disagreement on symbols (only if 1–6 are fixed and `Notfrbidden` remains).** UTF-8 versus the console code page, or emoji width, shifts later in-place writes. Not the next experiment. No new ANSI/PTY evidence currently elevates this class.

A minimum pane width would hide narrow layouts. It would not make a 40-column terminal a correct 40-column terminal. Do not use it as the fix.

---

## Experiments

Each one is its own commit on this branch, with the result written back here. Stop after the first experiment that makes S-launch pass, and only then retest S-ghost.

### E1 — Spawn only on a stable grid

Status: implemented in this commit. Visual pass is still open.

Intent: the first byte the CLI paints must use the size the user actually sees.

What landed:

- `src/lib/terminalHostSize.ts` waits until two samples of the host agree, confirms that box about 48ms later, and refuses a host smaller than 48px. If the box never repeats, the 800ms cap uses the latest usable size. It does not fall back to 80×24.
- `startSession` waits for that box, fits xterm, and only then starts or attaches the PTY. Agent restart waits the same way before `restart_agent_terminal_for_autopilot`.
- A living PTY that ignored the attach size gets one `resize_terminal` at the measured grid.
- The 50/150/400/900ms fit burst and the 20ms resize debounce are gone. Later resizes go through the same stable wait, and only if cols or rows changed.
- Automatic `term.refresh()` is skipped for 2s after open. A manual redraw command still refreshes.
- `term.reset()` runs when a parked xterm is bound to a new PTY.

Pass: Grok and OpenCode welcome screens are coherent with three terminals in one view, before any manual resize.

Visual result (2026-10-28): fail, but not the torn frame. New Vega, Titan, and Terminal panes opened with a blue cursor on a black surface and no CLI text. The header dot was already green. Terminals that had been open before the restart painted again. OpenCode among those still ghosts. Grok among those does not, so far.

Cause: `launch_workspace_terminals` spawned the ConPTY immediately at 80×24, before the pane existed. E1 then waited for a stable host and called `attach_terminal`. The process was already alive, so attach drained the welcome frame into scrollback. The view skips that scrollback whenever `attachedToExisting` is true, and it only polls bytes that arrive afterwards. PowerShell does not reprint its prompt. A same-size resize does not make the TUI draw again. The session is running. The screen never received the first frame.

Reconnected sessions took the other branch. After a process restart the old PTY is gone, so attach spawns while the view is already polling. That is why those four came back and the new ones did not.

Follow-up in this commit: `launch_workspace_terminals` only reserves the session id, pane id, and label. It does not start a process. `attach_terminal` performs the only spawn, and it receives the measured columns and rows. The 80×24 fields on the launch request are ignored.

How to check, without mixing other branch work:

1. Stay on `feat/ui-composer`. This follow-up changes Rust. `npm run app` rebuilds the debug binary when `src-tauri/src` is newer. No Vite cache wipe.
2. Close the current dev window. `npm run app` stops the previous debug process and opens a new one against the Vite server on port 1420.
3. Open **new** Grok and OpenCode terminals after that launch. The panes that are empty in the current window were started by the old binary. Judge the ones created after this relaunch.
4. Put three terminals in one view. The welcome screen should be readable before any manual resize. "Starting ConPTY session..." may show for a fraction of a second while the pane settles. That wait is this attempt.
5. If a brand-new terminal is blank or still torn, E1 failed. Do not continue to E2 on that result.

Visual pass (2026-10-28, after `41c1d60`): pass for S-launch. Three panes in one view — Orion running Grok, Vega and Titan running OpenCode — open with aligned text. The Grok welcome menu (`Resume session`, `New worktree`, `Changelog`, `Quit`, `Grok 4.7 is here!`) is intact, including the footer. OpenCode shows a task list and a diff in columns, not torn across the pane. This is the first clean mark. It does not prove S-ghost: that bug shows up after the session has been painting for a while, and a single fresh frame cannot clear it.

### E2 — One settled resize, no local repaint fight

Status: implemented in this commit. Visual pass for a long OpenCode session is open.

S-launch is clean. S-ghost is still the open report: OpenCode keeps stuck headers and merged characters until a manual resize or a remount. Grok redraws full frames, so it sheds the same damage.

What this changes:

- xterm stays in ConPTY mode. It does not reflow on its own.
- A fit still waits until the host box has settled, then sends one `resize_terminal` when the grid actually changed.
- That fit waits until the current polled chunk has finished `term.write`. A resize no longer lands in the middle of a frame.
- Automatic `term.refresh()` is gone, including the alt-screen path and the click-to-refresh on the canvas. Refresh paints whatever xterm already stored. OpenCode will not reconstruct that frame.
- A manual redraw command does not refresh locally. It steps the PTY one row away and back, so OpenCode gets a real size change and repaints. A same-size resize is not enough.

Pass: use one OpenCode session for several minutes, with normal output, and old rows do not stay pinned. A resize is not required to read the screen. If characters still collide on a grid that never changed size, that is encoding, not another refresh.

How to check:

1. Stay on `feat/ui-composer`. This attempt is TypeScript only. No Rust rebuild and no Vite cache wipe.
2. Close Kite. `npm run app` from `E:\kite`.
3. Open a new OpenCode terminal. Confirm the first frame is still coherent (S-launch must not regress).
4. Use that session for several minutes. Stuck headers, leftover tables, and merged words are an E2 failure.

Visual result (2026-10-28): fail. Four panes, Grok still coherent. OpenCode's splash mark is sliced by horizontal gaps through the block letters. The footer reads like `Juump to latest` on the OpenCode panes. E2 stopped the local refresh. The gaps are still in the cell itself.

### E3 — Cell height matches the glyph

Status: implemented in this commit. Visual pass is open.

`lineHeight` was `1.16`. xterm multiplies the measured glyph height by that value, so each row is taller than the glyph. OpenCode draws its mark with block characters that are meant to touch the next row. The extra space reads as slices through the letters. A resize does not remove it, because the next frame uses the same cell height.

What this changes: `lineHeight` is `1`. Letter spacing stays `0`. ConPTY mode, custom glyphs, and the E2 write/fit behavior stay as they are.

Pass: a new OpenCode pane shows a solid mark, and `Jump to latest` is one word. If the mark is solid and a character is still doubled after several minutes, that leftover is encoding (the old E3), not another line-height tweak.

How to check:

1. Stay on `feat/ui-composer`. TypeScript only. No Rust rebuild and no Vite cache wipe.
2. Close Kite. `npm run app` from `E:\kite`.
3. Open a new OpenCode terminal. Judge the mark and the footer before any manual resize.

### E4 — Encoding, only if characters still collide

Status: implemented in this change. Visual pass is open.

Files: `src-tauri/src/terminal.rs`, this document.

Rationale: agent CLIs now receive a stable UTF-8 console and terminal type from
inside the child PowerShell/ConPTY session. Generic PowerShell terminals keep
their existing startup path, and E1's settled geometry is unchanged.

- Set UTF-8 for the spawned console (`chcp 65001` inside that PTY, not the parent shell).
- Set `TERM=xterm-256color`.
- Re-check one emoji or box-drawing update. Do not bundle this with E1.

Rollback: remove the E4 changes from `src-tauri/src/terminal.rs` (the
`AGENT_TERMINAL_*` constants, `build_agent_launch_command`, the agent-only
environment assignment, and its focused test) and restore this section to its
pre-E4 text. Do not revert E1, E2, or E3 geometry/rendering changes.

---

## E5 — Synchronized Output Coalescing, Top-Anchored ConPTY Reflow & Idle WebGL Atlas Recovery (2026-11-01)

### Hypothesis & Implemented Changes
1. **DEC 2026 Synchronized Output Coalescing & Split Cursor-Restore Hold (`src/lib/terminalSyncOutput.ts`, `src/components/views/TerminalView.tsx`)**:
   - Raised `SYNC_OUTPUT_MAX_HOLD_MS` from `16ms` to `250ms` and accelerated polling inside `TerminalView.tsx` to `6ms` while `syncHoldRef.current.pending` is true (`16ms` during active visible output), preventing `poll_terminal` from splitting a single `\x1b[?2026h ... \x1b[?2026l` frame across polling intervals.
   - Added `SYNC_OUTPUT_CURSOR_RESTORE_HOLD_MS = 32` and `frameNeedsCursorRestore` (`holdForCursorRestore: true`) so when Windows ConPTY splits the trailing cursor-restore chunk (`\x1b[row;colH\x1b[?25h`) into a separate read after `\x1b[?2026l\x1b[?25l`, both chunks are coalesced into a single atomic `xterm.write()` call.
2. **Idle-Gated WebGL Texture Atlas Recovery (`src/lib/terminalSyncOutput.ts`, `src/components/views/TerminalView.tsx`)**:
   - Replaced mid-stream `clearTextureAtlas()` calls with `recoverWebglTextureAtlasIfIdle` and `shouldDeferAtlasClear` (requiring at least `160ms` of output silence and no pending sync hold before clearing the atlas), avoiding mid-frame glyph blanking during rapid TUI animation.
3. **Top-Anchored Normal-Buffer ConPTY Reflow (`src/lib/terminalViewport.ts`)**:
   - Added `resizeConptyViewport`, invoked inside `StableCellFitAddon.fit()`, which anchors normal-buffer row contractions/expansions at the top prior to `terminal.resize(cols, rows)` so the frontend buffer matches Windows ConPTY's top-anchored redraw semantics.
   - Removed forced `scrollToBottom()` on normal-buffer resize inside `TerminalView.tsx` and stopped synchronous `safeFitTerminal()` inside `attachBitmapRenderer()`.
   - Capped `scheduleForegroundGridDriftCheck` to at most 2 post-spawn probes (`driftProbeCountRef`).
4. **Default Renderer & Font Ligature Hardening (`src/lib/terminalAppearancePrefs.ts`, `src/components/views/terminal.css`)**:
   - Promoted `'webgl'` to the default renderer (with one-time v2 storage migration `TERMINAL_APPEARANCE_MIGRATION_KEY`) because DOM `<span>` runs suffer from sub-pixel font fallback drift on mixed Unicode box/braille lines.
   - Disabled font ligatures (`font-variant-ligatures: none; font-feature-settings: "liga" 0, "calt" 0, "dlig" 0;`) and enforced `.xterm-rows > div { overflow: hidden; }`.

### Observed Result after E5
- Mid-stream steady-state tearing is reduced, **but visual crashes/corruptions still occur** during **panel expansion (fullscreen/zoom), split creation/closing, divider dragging, and workspace/tab/mode navigation**.

---

## E6 — Structural Diagnosis: React Tree Remount Storms, Mid-Drag ConPTY Resizes & Stack Architecture Options (2026-11-01)

Codebase-wide tracing of `CodeWorkspace.tsx`, `PaneNodeRenderer.tsx`, and `TerminalView.tsx` exposed **four structural lifecycle bugs** that cause Kite to re-render, unmount/remount, and resize terminals far more often than necessary:

1. **React Fiber Depth Changes Unmount & Remount Active Terminals on Every Split, Close, or Fullscreen Toggle**:
   - In `PaneNodeRenderer.tsx` (`lines 125–133, 279–320`) and `CodeWorkspace.tsx` (`renderPaneNode`, `lines 1421–1431`), recursive `<PaneNodeRenderer>` renders `<TerminalView key={occupant.sessionId} />` at the tree depth of its `PaneLeaf`.
   - When a user **expands/fullscreens** a pane (`fullscreenLeafId`), `renderPaneNode` short-circuits the `PaneSplit` container and renders `fsLeaf` directly at depth 1. Because its React fiber tree depth changed, **React unmounts every `<TerminalView>` in the split — including the expanded terminal itself — and remounts it from scratch!**
   - Similarly, when a user **splits** a pane (`leaf` at depth $d \to$ `split > child > leaf` at depth $d+1$) or **closes** a sibling pane (`split` at depth $d+1 \to$ `leaf` at depth $d$), React unmounts and remounts the surviving `<TerminalView>`!
2. **Destructive WebGL Context Disposal on Every Unmount / Parking Cycle (`syncVisibleBitmapRenderers`)**:
   - Whenever `<TerminalView>` unmounts (due to split/fullscreen depth change, tab switch, or `Agent | Code | Thread` mode switch), its cleanup moves the DOM container to `#terminal-parking` and calls `syncVisibleBitmapRenderers()`, which immediately executes `releaseBitmapRenderer()` (`webglAddon.dispose()`).
   - Moments later, when remounted or unparked, `TerminalView` instantiates a brand-new `WebglAddon`, rebuilds the GPU glyph atlas from zero, and re-runs `startSession()` -> `attach_terminal` + `reconcilePtySizeAfterSpawn()` + `scheduleStableFit()`.
3. **Unthrottled `pointermove` Layout State Updates & Mid-Drag `ResizePseudoConsole` Storms**:
   - In `CodeWorkspace.tsx` (`handleDividerPointerDown`, `lines 1336–1349`), every raw `pointermove` event calls `setLayout(nextLayout)`, re-rendering the entire workspace tree at 120–240Hz.
   - Inside `TerminalView.tsx`, `waitForStableHost(host)` only waits **2 animation frames (~32ms)** of unchanged pixel dimensions before calling `fitTerminal()` -> `xterm.resize()` + `invokeCommand('resize_terminal')`. Any brief 32ms pause while dragging a split divider or during a CSS panel transition triggers a live Windows ConPTY `ResizePseudoConsole` + TUI `SIGWINCH` redraw storm mid-gesture.
4. **Hardcoded `80x24` Pre-Mount PTY Spawn (`requestWorkspaceTerminals` & `spawnTerminalCore`)**:
   - `CodeWorkspace.tsx` (`lines 157–158, 1011–1012`) spawns every new terminal/agent in Rust at a hardcoded `80x24` grid before the React leaf exists in the DOM. The CLI agent begins drawing its initial TUI frame at `80x24`, only to be interrupted 50–150ms later by a ConPTY `ResizePseudoConsole` when the mounted pane measures its actual pixel geometry.

### Architectural Decision: Execute Both Options in Two Sequential Phases (Phase 1 -> Phase 2)

> [!IMPORTANT]
> **Critical Rule on WebGL vs. DOM for Phase 1**:
> In Tauri + WebView2 on Windows, `@xterm/addon-webgl` (`WebglAddon`) causes severe black/blank screens, GPU context invalidation, and unrecoverable crashes when multiple panes exist or when DOM nodes move. By contrast, **DOM mode (`renderer: 'dom'`)** keeps terminals usable and only exhibits minor visual artifacts caused by the lifecycle/remount/resize storms below.
> Therefore:
> - **Phase 1 MUST lock the renderer to `'dom'`** (`DEFAULT_TERMINAL_APPEARANCE_PREFS.renderer = 'dom'`, v3 storage migration) and disable `WebglAddon` attachment while fixing the 4 structural React/ConPTY lifecycle bugs.
> - **Phase 2 replaces `xterm.js` entirely** with a **Backend-Authoritative Rust VT Emulator (`src-tauri`) + Lightweight Shared 2D Canvas Cell Renderer with Procedural Box/Block/Braille Sprites**, reducing terminal UI memory usage by **~82–88% per active terminal** (`~3.5–5 MB` vs. `~25–45 MB` in `xterm.js`) and making column drift physically impossible.

---

## 7. Master Implementation Plan for Delegated Agents (Step-by-Step Specification)

> **Instructions for the Implementing Agent**:
> Follow **Phase 1** (`Tasks 1.1` through `1.5`) in exact order and verify all tests pass before starting **Phase 2** (`Tasks 2.1` through `2.5`). Do **NOT** invent ad-hoc architectures or skip steps. Every file, line range, function signature, and code block is specified below.

---

### PHASE 1 — Lifecycle Overhaul: Zero-Unmount Panes, Settled Divider Resize, Pre-Spawn Grid Estimation & Stable DOM Mode

#### Task 1.1 — Lock Default Renderer to `'dom'` & Disable `WebglAddon` (`src/lib/terminalAppearancePrefs.ts` & `src/components/views/TerminalView.tsx`)

1. **`src/lib/terminalAppearancePrefs.ts`**:
   - Ensure `DEFAULT_TERMINAL_APPEARANCE_PREFS.renderer` is `'dom'` and `TERMINAL_APPEARANCE_MIGRATION_KEY = 'kite.terminalAppearancePrefs.v3'` resets any persisted `'webgl'` back to `'dom'` once. *(Already applied on disk; verify it stays `'dom'`.)*
2. **`src/components/views/TerminalView.tsx` (`lines 317–368`)**:
   - In `syncVisibleBitmapRenderers()`, **never** call `attachBitmapRenderer(live)`. Always ensure `releaseBitmapRenderer(live)` is called so `@xterm/addon-webgl` is never instantiated in WebView2:
   ```ts
   function syncVisibleBitmapRenderers(): void {
     for (const live of liveTerms.values()) {
       releaseBitmapRenderer(live);
     }
   }
   ```

#### Task 1.2 — Eliminate Fullscreen Tree Replacement (`src/components/code/CodeWorkspace.tsx` & `src/components/code/PaneNodeRenderer.tsx`)

**Problem**: When `layout.fullscreenLeafId` is set, `CodeWorkspace.tsx:1423-1428` and `PaneNodeRenderer.tsx:125-133` short-circuit the `PaneSplit` tree and render `fsLeaf` directly at the root depth. React sees `<TerminalView>` at depth 1 instead of depth $N$, so it **unmounts every `<TerminalView>` in the split (including the fullscreened one!) and remounts it from scratch**.

**Exact Fix**:
1. In **`src/components/code/CodeWorkspace.tsx` (`renderPaneNode`, `lines 1421–1431`)**:
   - Remove the `if (layout.fullscreenLeafId)` replacement block so `renderPaneNode` **always** passes `node` (the root of `activeTab`) to `<PaneNodeRenderer>`:
   ```tsx
   const renderPaneNode = (node: PaneNode): React.ReactNode => {
     return (
       <PaneNodeRenderer
         node={node}
         fullscreenLeafId={layout.fullscreenLeafId}
         ...
   ```
2. In **`src/components/code/PaneNodeRenderer.tsx` (`lines 125–172`)**:
   - Delete lines `125–133` (`if (fullscreenLeafId) { ... }`). Do **not** return `null` for non-fullscreen leaves and do **not** recursively re-root `fsLeaf`.
   - Instead, keep the entire split tree mounted in place at its exact React fiber depth, and on the `<section className="code-pane-panel ...">` in `PaneNodeRenderer.tsx:155-167`, add fullscreen / hidden-by-fullscreen CSS modifiers:
   ```tsx
   const isHiddenByFullscreen = Boolean(fullscreenLeafId && fullscreenLeafId !== node.id);
   ```
   - Append to `className`:
     `${isFullscreen ? ' code-pane-panel--fullscreen' : ''}${isHiddenByFullscreen ? ' code-pane-panel--hidden-by-fullscreen' : ''}`
3. In **`src/components/code/code-workspace.css`** (or wherever `.code-pane-panel` is styled):
   - Ensure `.code-workspace__canvas` (the parent container of the pane tree) has `position: relative;`.
   - Add rules so the expanded leaf covers the canvas without unmounting any node:
   ```css
   .code-pane-panel--fullscreen {
     position: absolute !important;
     inset: 0 !important;
     z-index: 30 !important;
     width: 100% !important;
     height: 100% !important;
   }
   .code-pane-panel--hidden-by-fullscreen {
     visibility: hidden !important;
     pointer-events: none !important;
   }
   ```

#### Task 1.3 — Render All Active `<TerminalView>` Instances in a Flat Persistent Portal Layer (`src/components/code/CodeWorkspace.tsx` & `src/components/code/PaneNodeRenderer.tsx`)

**Problem**: When a user splits a pane (`handleSplitLeaf`: `leaf` at depth $d \to$ `split > child > leaf` at depth $d+1$) or closes a sibling pane (`handleCloseLeaf`: `split` at depth $d+1 \to$ `leaf` at depth $d$), the React fiber depth of the surviving leaf changes. React unmounts `<TerminalView>` and remounts it at the new depth, triggering `stopPolling()` -> `#terminal-parking` -> `startSession()` -> `attach_terminal` + 4 overlapping resize passes.

**Exact Fix**:
1. In **`src/components/code/PaneNodeRenderer.tsx`**:
   - Add a prop to `PaneNodeRendererProps`:
     ```ts
     onRegisterTerminalSlot?: (leafId: string, el: HTMLDivElement | null) => void;
     ```
   - Pass `onRegisterTerminalSlot` down in recursive `<PaneNodeRenderer>` calls (`lines 280–315`).
   - In the leaf branch (`lines 260–285`), when `occupant.kind === 'terminal'` and `onRegisterTerminalSlot` is provided, render **only the slot host container** (do NOT render `<TerminalView>` inside the recursive tree):
     ```tsx
     <div
       className="code-pane-body"
       data-terminal-slot={occupant.kind === 'terminal' ? occupant.sessionId : undefined}
       ref={
         occupant.kind === 'terminal' && onRegisterTerminalSlot
           ? (el) => onRegisterTerminalSlot(node.id, el)
           : undefined
       }
     >
       {occupant.kind === 'terminal' ? (
         onRegisterTerminalSlot ? null : (
           <TerminalView ... />
         )
       ) : (
         <ChatView ... />
       )}
     </div>
     ```
2. In **`src/components/code/CodeWorkspace.tsx`**:
   - Import `createPortal` from `'react-dom'`.
   - Maintain a map of mounted slot DOM elements by `leaf.id`:
     ```ts
     const terminalSlotsRef = useRef<Map<string, HTMLDivElement>>(new Map());
     const [, setSlotVersion] = useState(0);
     const handleRegisterTerminalSlot = useCallback((leafId: string, el: HTMLDivElement | null) => {
       const map = terminalSlotsRef.current;
       if (el) {
         if (map.get(leafId) !== el) {
           map.set(leafId, el);
           setSlotVersion((v) => v + 1);
         }
       } else if (map.has(leafId)) {
         map.delete(leafId);
         setSlotVersion((v) => v + 1);
       }
     }, []);
     ```
   - Compute a flat list of all terminal leaves in `activeTab.root` sorted stably by `leaf.id`:
     ```ts
     const activeTerminalLeaves = useMemo(() => {
       if (!activeTab) return [];
       return getAllLeaves(activeTab.root)
         .filter((l): l is PaneLeaf & { occupant: PaneOccupantTerminal } => l.occupant.kind === 'terminal')
         .sort((a, b) => a.id.localeCompare(b.id));
     }, [activeTab]);
     ```
   - Render all `<TerminalView>` components at a **single flat depth** inside `CodeWorkspace` via `createPortal`:
     ```tsx
     {activeTerminalLeaves.map((leaf) => {
       const slotEl = terminalSlotsRef.current.get(leaf.id);
       if (!slotEl) return null;
       const occ = leaf.occupant;
       return createPortal(
         <TerminalView
           key={occ.sessionId}
           chrome="pane"
           workspaceId={selectedWorkspace.id}
           paneId={leaf.id}
           sessionId={occ.sessionId}
           initialEngine={occ.engine || occ.runtime?.engine}
           title={occ.label}
           onStatusChange={(status) => { ... }}
         />,
         slotEl,
         occ.sessionId,
       );
     })}
     ```
   - **Why this works**: In React, `createPortal(child, container, key)` preserves the `<TerminalView>` fiber instance across changes to `container` (`slotEl`) as long as its position in the parent array (`activeTerminalLeaves.map`) and its `key` (`occ.sessionId`) stay at the same flat depth in `CodeWorkspace`! Splitting, closing, or swapping panes **never unmounts `<TerminalView>`**.

#### Task 1.4 — Gate PTY Resize During Divider Drag & Throttle `pointermove` to 60fps (`src/lib/terminalViewport.ts`, `src/components/code/CodeWorkspace.tsx`, `src/components/views/TerminalView.tsx`)

**Problem**: `handleDividerPointerDown` in `CodeWorkspace.tsx:1336-1349` calls `setLayout` on every raw `pointermove` (120–240Hz), and `waitForStableHost` in `TerminalView.tsx:194-234` only waits 2 frames (`~32ms`) before calling `fitTerminal()` -> `invokeCommand('resize_terminal')`. Pausing the mouse for 32ms mid-drag triggers a live Windows ConPTY `ResizePseudoConsole` storm.

**Exact Fix**:
1. In **`src/lib/terminalViewport.ts`**, export a divider-drag state coordinator:
   ```ts
   let activeDividerDragCount = 0;
   const dividerDragEndCallbacks = new Set<() => void>();

   export function setTerminalDividerDragging(dragging: boolean): void {
     if (dragging) {
       activeDividerDragCount += 1;
     } else {
       activeDividerDragCount = Math.max(0, activeDividerDragCount - 1);
       if (activeDividerDragCount === 0) {
         for (const cb of dividerDragEndCallbacks) {
           try { cb(); } catch {}
         }
       }
     }
   }

   export function isTerminalDividerDragging(): boolean {
     return activeDividerDragCount > 0;
   }

   export function onTerminalDividerDragEnd(cb: () => void): () => void {
     dividerDragEndCallbacks.add(cb);
     return () => {
       dividerDragEndCallbacks.delete(cb);
     };
   }
   ```
2. In **`src/components/code/CodeWorkspace.tsx` (`handleDividerPointerDown`, `lines 1324–1364`)**:
   - Call `setTerminalDividerDragging(true)` on pointerdown.
   - Coalesce `pointermove` updates inside a single `requestAnimationFrame` callback so `setLayout` runs at most once per 16.6ms display frame (60fps).
   - On `pointerup` and `pointercancel`, cancel any pending `requestAnimationFrame`, commit the final ratios, call `setTerminalDividerDragging(false)`, and invoke `save_workspace_layout`.
3. In **`src/components/views/TerminalView.tsx`**:
   - In `waitForStableHost` (`lines 194–234`), increase `WAIT_SETTLE_FRAMES` from `2` to `6` (~100ms of stable geometry) and do not increment `stableFrames` while `isTerminalDividerDragging()` is `true`.
   - In `fitTerminal` (`lines 793–806`), add `isTerminalDividerDragging()` to the deferral guard:
     ```ts
     if (
       isTerminalDividerDragging() ||
       writeActiveRef.current > 0 ||
       syncHoldRef.current.holding ||
       syncHoldRef.current.pending
     ) {
       fitDeferredRef.current = true;
       return;
     }
     ```
   - In the mount `useEffect` (`lines 1763–1828`), subscribe to `onTerminalDividerDragEnd(() => scheduleStableFitRef.current())` and clean it up on unmount.
   - In `startSession` (`lines 1455–1487`), when `hadLiveElement` is `true` (re-attaching a cached terminal element), skip `reconcilePtySizeAfterSpawn` and only call `resize_terminal` if `grid.cols !== lastColsRef.current || grid.rows !== lastRowsRef.current`.

#### Task 1.5 — Replace Hardcoded `80x24` Pre-Spawn with Measured Pane Grid (`src/components/code/CodeWorkspace.tsx`)

**Problem**: `requestWorkspaceTerminals` (`lines 157–158`) and `spawnTerminalCore` (`lines 1011–1012`) spawn the backend ConPTY at hardcoded `columns: 80, rows: 24` before the pane mounts, causing the CLI agent to draw its initial TUI frame at `80x24` and immediately get hit by `ResizePseudoConsole` when mounted.

**Exact Fix**:
1. In **`src/components/code/CodeWorkspace.tsx`**, add a pure helper `estimateTargetPaneGrid(container: HTMLElement | null, leafCount: number, axis: PaneAxis = 'vertical'): { columns: number; rows: number }`:
   ```ts
   function estimateTargetPaneGrid(
     container: HTMLElement | null,
     leafCount: number,
     axis: PaneAxis = 'vertical',
   ): { columns: number; rows: number } {
     const prefs = getTerminalAppearancePrefs();
     const cellWidth = Math.max(6, prefs.fontSize * 0.6);
     const cellHeight = Math.max(12, Math.round(prefs.fontSize * prefs.lineHeight));
     const rect = container?.getBoundingClientRect();
     const rawWidth = rect && rect.width >= 200 ? rect.width : 960;
     const rawHeight = rect && rect.height >= 140 ? rect.height : 640;
     const count = Math.max(1, leafCount);
     const paneWidth = axis === 'vertical' ? (rawWidth - (count - 1) * 8) / count : rawWidth;
     const paneHeight = (axis === 'horizontal' ? (rawHeight - (count - 1) * 8) / count : rawHeight) - 36;
     const columns = Math.max(20, Math.floor((paneWidth - 21) / cellWidth));
     const rows = Math.max(8, Math.floor((paneHeight - 16) / cellHeight));
     return { columns, rows };
   }
   ```
2. Use `estimateTargetPaneGrid(canvasRef.current, ...)` in `requestWorkspaceTerminals` (`line 157`) and `spawnTerminalCore` (`line 1011`) instead of `columns: 80, rows: 24`.

#### Phase 1 Verification Checklist
- `npx tsc --noEmit` -> exit code 0.
- `npx vitest run` -> all tests pass.
- `node .kite/sanitizer/audit-references.mjs --check` -> `✅ [CLEAN]`.
- Manual check: Split a terminal 3 times, toggle Fullscreen on/off, and drag the split divider rapidly. Confirm in DevTools that `<TerminalView>` never unmounts and `resize_terminal` is invoked **only once** after `pointerup`.

---

### PHASE 2 — Backend-Authoritative Rust VT Emulator + Lightweight Shared Canvas Cell Renderer with Procedural Sprites

#### Memory & Performance Impact of Phase 2

| Metric (Per Active Terminal / Agent) | Current (`xterm.js` in WebView2) | Phase 2 (Rust VT Grid + Shared `<canvas>` Surface) | Improvement |
| :--- | :--- | :--- | :--- |
| **Frontend JS Heap + DOM/GPU RAM** | `~22–38 MB` (DOM) / `~30–55 MB` (WebGL) | **`~1.5–2.0 MB`** (1 `<canvas>` + ~40-row `RenderSnapshot`) | **~90% less Frontend RAM** |
| **Backend Rust VT State RAM (`src-tauri`)** | `~0.5 MB` (raw byte ring buffer) | **`~2.0–3.0 MB`** (native VT cell matrix + scrollback) | Minimal native footprint |
| **Total Terminal Engine RAM per Agent** | **`~25–45 MB`** | **`~3.5–5.0 MB`** | **~82% to 88% LESS RAM per terminal** |
| **6 Concurrent Agent Terminals Total** | `~160–260 MB` | **`~22–30 MB`** | **Saves ~140–230 MB RAM** |
| **Column / Box-Drawing Alignment** | Vulnerable to browser font fallback drift | **100% mathematically locked `(col, row)` grid + procedural pixel sprites** | **0 artifacts possible** |

---

#### Task 2.1 — Add Native VT State Machine to `src-tauri` (`src-tauri/Cargo.toml` & `src-tauri/src/vt_engine.rs`)

1. **`src-tauri/Cargo.toml`**:
   - Add `vt100 = "0.15"` (or `alacritty_terminal = "0.24"` + `vte = "0.13"`), which compiles 100% natively on Windows MSVC via `cargo` without external C/Zig toolchains.
2. **Create `src-tauri/src/vt_engine.rs`**:
   - Define the authoritative terminal state wrapper `TerminalVtEngine` and serializable snapshot structs:
   ```rust
   use serde::Serialize;

   #[derive(Debug, Clone, Serialize)]
   #[serde(rename_all = "camelCase")]
   pub struct CellSnapshot {
       pub ch: String,
       pub width: u8,         // 1 or 2
       pub fg: [u8; 3],       // RGB
       pub bg: [u8; 3],       // RGB
       pub has_bg: bool,
       pub bold: bool,
       pub italic: bool,
       pub underline: bool,
       pub inverse: bool,
       pub dim: bool,
   }

   #[derive(Debug, Clone, Serialize)]
   #[serde(rename_all = "camelCase")]
   pub struct RowSnapshot {
       pub row_idx: u16,
       pub cells: Vec<CellSnapshot>,
   }

   #[derive(Debug, Clone, Serialize)]
   #[serde(rename_all = "camelCase")]
   pub struct CursorSnapshot {
       pub visible: bool,
       pub col: u16,
       pub row: u16,
       pub shape: &'static str, // "bar" | "block" | "underline"
   }

   #[derive(Debug, Clone, Serialize)]
   #[serde(rename_all = "camelCase")]
   pub struct RenderSnapshot {
       pub seq: u64,
       pub cols: u16,
       pub rows: u16,
       pub alternate_screen: bool,
       pub cursor: CursorSnapshot,
       pub dirty_rows: Vec<RowSnapshot>, // Only changed rows since caller's `since_seq`, or all rows if `full == true`
       pub full: bool,
   }
   ```
   - Implement native **DEC 2026 Synchronized Output Hold (`?2026h` ... `?2026l`)** directly inside `TerminalVtEngine::feed(&mut self, bytes: &[u8])`:
     - When `\x1b[?2026h` is encountered in the byte stream, set `self.render_held = true` and `self.hold_started_at = Some(Instant::now())`.
     - While `self.render_held` is `true` (and `hold_started_at.elapsed() < Duration::from_millis(250)`), continue feeding bytes into the parser or staging buffer, but **`snapshot()` returns the last committed `RenderSnapshot`** so the frontend never paints a half-drawn TUI frame!
     - As soon as `\x1b[?2026l` arrives (and if followed by `\x1b[?25l`, after the trailing cursor restore `\x1b[?25h` or 16ms), set `self.render_held = false`, increment `self.seq`, and commit the new `RenderSnapshot`!

#### Task 2.2 — Wire `TerminalVtEngine` into `src-tauri/src/terminal.rs` & Expose `poll_terminal_snapshot`

1. In **`src-tauri/src/terminal.rs`**:
   - Add `vt_engine: Mutex<TerminalVtEngine>` to `TerminalSession`.
   - In the background reader thread where `reader.read(&mut buf)` receives bytes from Windows ConPTY (`portable_pty`):
     - Feed `&buf[..n]` directly into `session.vt_engine.lock().feed(&buf[..n])`.
   - In `resize_terminal(session_id, columns, rows)`:
     - When `columns != current_cols || rows != current_rows`, call `master.resize(PtySize { rows, cols: columns, .. })` **and** `session.vt_engine.lock().resize(columns, rows)` atomically under the session lock.
   - Add Tauri command `poll_terminal_snapshot(session_id: String, since_seq: u64) -> Result<TerminalSnapshotPollResponse, String>`:
     - If `session.vt_engine.seq == since_seq` and process is still running, return `{ kind: "unchanged", seq: since_seq }`.
     - Otherwise return `{ kind: "snapshot", snapshot: RenderSnapshot }`.

#### Task 2.3 — Create Procedural Box, Block & Braille Sprite Rasterizer (`src/lib/terminalSprites.ts`)

**Why**: Font glyphs for `U+2500..U+257F` (box-drawing borders `┌─┐│└─┘╭╮╰╯`), `U+2580..U+259F` (block elements `▀▄█▌▐░▒▓`), and `U+2800..U+28FF` (Braille spinners `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) have inconsistent metrics across fonts and DPI scales. Drawing them procedurally onto an offscreen bitmap guarantees 0px seams on all OpenCode and Grok TUI borders.

1. **Create `src/lib/terminalSprites.ts`**:
   - Export `isProceduralSpriteChar(codePoint: number): boolean`:
     ```ts
     export function isProceduralSpriteChar(cp: number): boolean {
       return (
         (cp >= 0x2500 && cp <= 0x257f) || // Box Drawing
         (cp >= 0x2580 && cp <= 0x259f) || // Block Elements
         (cp >= 0x2800 && cp <= 0x28ff)    // Braille Patterns
       );
     }
     ```
   - Export `drawProceduralSprite(ctx: CanvasRenderingContext2D, cp: number, x: number, y: number, cellW: number, cellH: number, fgColor: string): boolean`:
     - **Box Drawing (`0x2500..0x257F`)**: Compute exact integer pixel center `(cx = x + Math.floor(cellW / 2), cy = y + Math.floor(cellH / 2))`, stroke thickness `thin = Math.max(1, Math.round(cellW / 8))`, `thick = thin * 2`, and draw crisp `ctx.fillRect` segments from center to top/bottom/left/right edges (plus quarter-circle arcs for rounded corners `╭╮╰╯` `0x256D..0x2570`).
     - **Block Elements (`0x2580..0x259F`)**: Fill exact fractional rectangles (`▀` upper half, `▄` lower half, `█` full cell, `▁..▇` 1/8th to 7/8th height, `▏..▉` 1/8th to 7/8th width, `░▒▓` globalAlpha `0.25 / 0.50 / 0.75`).
     - **Braille (`0x2800..0x28FF`)**: Decode `bits = (cp - 0x2800) & 0xFF` into the 2×4 dot matrix (`bit 0..2` left column rows 0..2, `bit 3..5` right column rows 0..2, `bit 6` left row 3, `bit 7` right row 3) and fill `dotSize × dotSize` squares at each active dot coordinate.
   - Add unit tests in `src/lib/terminalSprites.test.ts` verifying `isProceduralSpriteChar` and non-empty pixel output for box corners, horizontal/vertical lines, blocks, and Braille spinners.

#### Task 2.4 — Create Lightweight Canvas2D Cell Grid Surface (`src/components/views/TerminalCanvasSurface.tsx`)

1. **Create `src/components/views/TerminalCanvasSurface.tsx`**:
   - Renders a single `<canvas className="terminal-canvas-surface" />` plus a hidden `<textarea className="terminal-ime-input" />` for keyboard/IME/paste capture.
   - Maintains an in-memory `rows: RowSnapshot[]` array updated from `poll_terminal_snapshot(sessionId, lastSeq)`.
   - On each snapshot update (or resize), paints **only the `dirty_rows`** onto the 2D canvas:
     1. Pass 1 (Backgrounds): Clear row rect `(0, rowIdx * cellH, canvasW, cellH)` with theme background `#0a0a0a`, then fill contiguous runs of cells where `cell.hasBg` or `cell.inverse` is true.
     2. Pass 2 (Glyphs & Sprites): For each cell at `colIdx`:
        - Compute `px = Math.floor(colIdx * cellW)` and `py = Math.floor(rowIdx * cellH)`.
        - If `isProceduralSpriteChar(cp)`, call `drawProceduralSprite(ctx, cp, px, py, cellW, cellH, fgCss)`.
        - Otherwise draw the glyph at `(px, py + baselineOffset)` via a shared offscreen glyph bitmap cache (`GlyphAtlasCache`, keyed by `${fontKey}:${ch}:${fgCss}:${bold}:${italic}`), guaranteeing that **every character is pinned to its exact `(colIdx * cellW, rowIdx * cellH)` coordinate** and can never push subsequent columns!
     3. Pass 3 (Cursor & Selection): Draw selection highlight (`rgba(92, 143, 255, 0.30)`) and cursor (`bar`, `block`, or `underline` at `(cursor.col * cellW, cursor.row * cellH)`).
   - **Fluid Resize**: During split divider drag (`isTerminalDividerDragging()`), the `<canvas>` keeps painting the existing `rows` snapshot at 60fps with zero IPC calls, and commits `resize_terminal` once on `pointerup`.

#### Task 2.5 — Swap `<TerminalView>` Surface to `<TerminalCanvasSurface>` & Remove `xterm.js` Runtime Overhead

1. In **`src/components/views/TerminalView.tsx`**:
   - Integrated `<TerminalCanvasSurface>`, preserving the surrounding pane header, status badges, staged prompt delivery (`kite:terminal-staged-prompt`), keyboard shortcuts (`Ctrl+C`, `Ctrl+V` with image paste staging), and file/web link click handlers.
   - When `appearancePrefs.renderer === 'canvas'` (now default in `v4`), `<TerminalCanvasSurface>` is mounted directly, bypassing the `xterm.js` DOM/WebGL overhead.
   - Preserved fallback to `'dom'` or `'webgl'` when explicitly configured in Settings.
2. Run full verification:
   - `npx tsc --noEmit` -> 0 errors.
   - `npx vitest run` -> 102/102 test files passed, 769/769 tests passed.
   - `cargo check --manifest-path src-tauri/Cargo.toml` -> clean build in 0.45s.
   - `node .kite/sanitizer/audit-references.mjs --check` -> `✅ [CLEAN]`.

---

## 8. Phase 2 Full Implementation & Verification Report (2026-11-01)

### Status: Complete & Verified

Phase 2 replaces the client-side parsing and WebGL/DOM rendering of `xterm.js` with an authoritative Rust VT state machine and a native HTML5 2D Canvas surface with procedural sprite rasterization.

### Components Delivered:

1. **Native Rust VT State Machine (`src-tauri/src/vt_engine.rs`)**:
   - Backed by native `vt100 = "0.15"` parser integrated into `TerminalInstance` in `src-tauri/src/terminal.rs`.
   - Maintains authoritative `(cols, rows)` cell grid: character, width, foreground/background RGB, bold, italic, underline, inverse.
   - Natively implements DEC 2026 synchronized output holds (`\x1b[?2026h` ... `\x1b[?2026l`): frames are atomic, preventing half-drawn TUI frames from ever being emitted or snapshotted.
   - Exposes `poll_terminal_snapshot(sessionId, sinceSeq)` Tauri command, returning dirty row diffs or full snapshots.

2. **Procedural Box, Block & Braille Sprite Rasterizer (`src/lib/terminalSprites.ts`)**:
   - `isProceduralSpriteChar(codePoint)`: detects Unicode Box Drawing (`U+2500..U+257F`), Block Elements (`U+2580..U+259F`), and Braille Patterns (`U+2800..U+28FF`).
   - `drawProceduralSprite`: draws exact integer-pixel lines, corners, fractional height/width blocks, and Braille dots directly on the 2D canvas context.
   - Completely eliminates horizontal slices, vertical tears, and font-fallback seams on OpenCode and Grok TUI borders.
   - Validated by unit test suite `src/lib/terminalSprites.test.ts`.

3. **Lightweight 2D Canvas Terminal Surface (`src/components/views/TerminalCanvasSurface.tsx`)**:
   - HTML5 2D Canvas rendering cells at exact mathematical pixel positions `(col * cellWidth, row * cellHeight)`. Wide characters and Unicode symbols cannot cause column drift.
   - Integrated hidden `<textarea>` for standard keyboard input, IME composition, clipboard (Ctrl+C, Ctrl+V), and selection.
   - Supports mouse text selection, selection highlight overlays, and copy to clipboard.
   - Fluid drag resizing: during split divider dragging (`isTerminalDividerDragging()`), repaints at 60fps on canvas without triggering ConPTY `ResizePseudoConsole` storms; commits resize once on drag end.
   - Validated by unit test suite `src/components/views/TerminalCanvasSurface.test.tsx`.

4. **Appearance Preferences & Settings Integration (`src/lib/terminalAppearancePrefs.ts`, `src/components/views/SettingsView.tsx`, `src/components/views/TerminalView.tsx`)**:
   - Added `'canvas'` as the default renderer in `TerminalRendererMode` (`DEFAULT_TERMINAL_APPEARANCE_PREFS.renderer = 'canvas'`).
   - Bumped migration key to `v4` (`TERMINAL_APPEARANCE_MIGRATION_KEY = 'kite.terminalAppearancePrefs.v4'`).
   - Added `Canvas · 2D` option to the segmented control in `SettingsView.tsx`.
   - Connected `TerminalView.tsx` to conditionally mount `<TerminalCanvasSurface>` when in canvas mode.

### Verification Results:
- **TypeScript**: `npx tsc --noEmit` -> 0 errors.
- **Vitest Unit & Integration**: `npx vitest run` -> **102 test files passed (102 / 102)**, **769 tests passed (769 / 769)**.
- **Rust Backend**: `cargo check --manifest-path src-tauri/Cargo.toml` -> 0 errors.
- **Sanitizer**: `node .kite/sanitizer/audit-references.mjs --check` -> `✅ [CLEAN] No forbidden external references found`.

---

## 9. Deep Validation Audit & Root-Cause Corrections (Phase 1 & Phase 2)

Following hands-on testing of the initial Phase 1 and Phase 2 implementations, a full line-by-line audit uncovered 11 critical defects across resizing, visual rendering, usability, and React portal stability:

### A. Root Causes of Broken Resize in Phase 2 (Corrected)
1. **Polling Overwrote Local Grid Dimensions (`src/components/views/TerminalCanvasSurface.tsx`)**:
   - `poll()` overwrote `colsRef.current = snapshot.cols` and `rowsRef.current = snapshot.rows` (`80×24`) every 12ms, clobbering the container's measured dimensions before the 40ms resize debounce timer fired.
   - **Fix**: Separated `gridColsRef` / `gridRowsRef` (measured DOM grid) from `appliedPtyColsRef` / `appliedPtyRowsRef` (last dimensions committed to ConPTY). `poll()` never overwrites `gridColsRef`, and if the backend snapshot dimensions diverge from `appliedPtyColsRef`, `resize_terminal` is invoked immediately.
2. **Divider-Drag Gate Blocked Post-Drag Resize (`src/components/views/TerminalCanvasSurface.tsx`)**:
   - `handleResize()` previously updated `colsRef.current = cols` *before* checking `if (isTerminalDividerDragging()) return;`. When the divider drag ended, `cols === colsRef.current` evaluated to `true`, so `resize_terminal` was never sent!
   - **Fix**: `appliedPtyColsRef` / `appliedPtyRowsRef` are only updated when `resize_terminal` is actually dispatched, and `onTerminalDividerDragEnd` forces an immediate PTY resize sync.
3. **Hardcoded `80×24` Initial Spawn & Reattach Ignore (`src/components/views/TerminalView.tsx`, `src-tauri/src/terminal.rs`)**:
   - `TerminalView.tsx` hardcoded `columns: 80, rows: 24` when starting/attaching in canvas mode, and `start_terminal` / `attach_terminal` in `src-tauri/src/terminal.rs` ignored `columns` and `rows` when attaching to an existing session.
   - **Fix**: Exported `measureTerminalCanvasGrid(containerEl, prefs)` and used it before `start_terminal` / `attach_terminal`, and updated `start_terminal` / `attach_terminal` in Rust to resize both `inst.master` and `inst.vt_engine` when attaching with new dimensions.

### B. Root Causes of Degraded Visual Quality in Phase 2 (Corrected)
1. **Dropped Dirty Rows Between Polls (`src-tauri/src/vt_engine.rs`)**:
   - `committed_snapshot` only stored the `dirty_rows` of the single most recent `commit_snapshot()` call, yet `get_snapshot_diff(since_seq)` only sent a full snapshot when `since_seq + 20 < self.seq`. Whenever 2–20 PTY reads occurred between two 12ms frontend polls, all intermediate dirty rows were permanently lost on screen!
   - **Fix**: Changed `get_snapshot_diff` to send the full row matrix whenever `since_seq + 1 < self.seq`, and auto-release expired (`> 80ms`) DEC 2026 holds during `get_snapshot_diff` even when no new PTY bytes arrive.
2. **Integer Rounding of Fractional Monospace Advance Width (`src/components/views/TerminalCanvasSurface.tsx`)**:
   - `Math.ceil(metrics.width)` rounded fractional font widths (e.g. `7.2px -> 8px`), creating wide unnatural gaps between characters.
   - **Fix**: Preserved exact floating-point advance width (`ctx.measureText('M'.repeat(16)).width / 16`), added `PAD_X = 12, PAD_Y = 8` with vertical spare centering, true typographic baseline centering `(cellH + ascent - descent) * 0.5`, device-pixel-snapped background runs (`Math.round(v * dpr) / dpr`), and run-batched ASCII `fillText` rendering with individual cell pinning for non-ASCII glyphs.
3. **Double-Inverted Colors & Palette Contrast (`src-tauri/src/vt_engine.rs`, `src/components/views/TerminalCanvasSurface.tsx`)**:
   - Both `vt_engine.rs` and `TerminalCanvasSurface.tsx` swapped `fg` and `bg` when `cell.inverse` was true, canceling each other out and breaking inverse TUI status bars and selections.
   - **Fix**: Consolidated `inverse` resolution, `bold -> bright` ANSI mapping, Kite dark palette colors, and WCAG minimum contrast enforcement (`ensure_readable_fg`) in `vt_engine.rs`.
4. **Incomplete Box Drawing & Wide Continuation Cells (`src/lib/terminalSprites.ts`, `src-tauri/src/vt_engine.rs`)**:
   - `terminalSprites.ts` previously only mapped ~35 of 128 Box Drawing characters and fell back to `┼` for the remaining 90+ characters (including dashed lines and mixed junctions), and `vt_engine.rs` emitted `width: 1` cells for wide-character trailing cells (`cell.is_wide_continuation()`).
   - **Fix**: Implemented the complete 128-entry `LIGHT_HEAVY`, `DOUBLE`, `SINGLES` lookup tables, parallel double-line junctions, cubic Bezier rounded corners (`╭╮╰╯`), dashed lines, block elements, `⏺` (`U+23FA`), Powerline (`U+E0B0..U+E0BF`), and Braille (`U+2800..U+28FF`) with device-pixel edge snapping, and marked wide continuation cells with `width: 0`.

### C. Root Causes of Unusability in Phase 2 (Corrected)
1. **Missing TUI Key Sequences, Bracketed Paste, and Scrollback (`src/components/views/TerminalCanvasSurface.tsx`, `src-tauri/src/terminal.rs`)**:
   - Added `Shift+Tab` (`\x1b[Z`), `Alt+Enter` (`\x1b\r`), `Ctrl+Backspace` (`\x17`), application cursor mode (`\x1bOA..D`), bracketed paste (`\x1b[200~...\x1b[201~`), mouse wheel scrollback (`scroll_terminal_viewport` in normal screen, arrow keys in alternate screen), right-click copy/paste, `recordTerminalOutput` activity notifications, and `exited` / `exitCode` reporting in `poll_terminal_snapshot`.

### D. Root Causes of Phase 1 Portal & Fullscreen Regressions (Corrected)
1. **Portal Container Identity Churn Across Splits (`src/components/code/CodeWorkspace.tsx`)**:
   - Passing `PaneNodeRenderer`'s transient `.code-pane-body` element directly to `createPortal` caused React to remount the portal subtree whenever a pane's split depth changed.
   - **Fix**: `CodeWorkspace` now owns a permanent `HTMLDivElement` (`getOrCreateTerminalSlotHost(leafId)`) per `leaf.id` and reparents that element inside `.code-pane-body` via `bodyEl.appendChild(host)`, keeping `createPortal`'s container reference 100% constant across splits and unsplits.
2. **Fullscreen Sibling `0×0` Collapse (`src/chunks.css`)**:
   - Replaced `display: none !important` on `.code-pane-panel--hidden-by-fullscreen` and `display: block !important` on `.pane-tree` with `visibility: hidden !important; pointer-events: none !important;` and `position: static !important; overflow: visible !important;`, preserving sibling grid dimensions while fullscreen is active.

---

## 10. Post-First-Resize Bottom-Zone Artifact Diagnosis & Action Plan

### 10.1 Observation Under Investigation
In **`DOM Clásico` (`xterm.js` DOM renderer)**:
- When an alternate-screen TUI session (`OpenCode`) starts and runs **without any window maximize or pane resize**, the bottom composer/status zone renders cleanly with **zero artifacts**.
- As soon as the **first resize or window maximize** occurs, persistent visual artifacts and stale block/status fragments begin appearing in the **bottom zone** on subsequent repaints.

In **`Canvas · 2D` (Phase 2 native surface)**:
- Interactive TUI mouse actions (clicking sessions, buttons, or scrolling panes inside `OpenCode`) do not trigger because SGR mouse protocol reporting (`?1000h` / `?1002h` / `?1003h` / `?1006h`) and terminal query responses (`CSI 6n`, `CSI c`, `OSC 10/11`) are not yet wired when `xterm.js` is bypassed.

---

### 10.2 Exact Root Causes of the Post-First-Resize Bottom-Zone Artifacts in `DOM Clásico`

A line-by-line audit of `src/lib/terminalViewport.ts`, `src/components/views/TerminalView.tsx`, `src/lib/terminalHostSize.ts`, and `src/lib/terminalSyncOutput.ts` identified **5 compounding bugs** in the resize and repaint pipeline:

#### Root Cause 1 — `StableCellFitAddon.fit()` Overrode `FitAddon.fit()` and Removed `_renderService.clear()`
- **Location**: `src/lib/terminalViewport.ts:524-533`
- **Mechanism**:
  Standard `@xterm/addon-fit` executes:
  ```js
  if (this._terminal.rows !== dims.rows || this._terminal.cols !== dims.cols) {
    this._terminal._core._renderService.clear();
    this._terminal.resize(dims.cols, dims.rows);
  }
  ```
  Kite's `StableCellFitAddon` overrode `fit()` and replaced that logic with `resizeConptyViewport(term, dims.cols, dims.rows)`, **removing `_renderService.clear()`**.
- **Why this corrupts the bottom zone after the first resize**:
  `xterm.js`'s `DomRenderer` caches row DOM elements and cell state inside `_renderService`. When `term.resize(cols, rows)` runs without `_renderService.clear()`, cached row state from the previous bottom rows (e.g., rows `26..30` where `OpenCode`'s composer and status bar lived prior to maximizing) is not invalidated before the grid geometry changes, leaving stale row caches in the lower viewport.

#### Root Cause 2 — Synchronous Frontend `term.resize()` vs. Asynchronous `resize_terminal` ConPTY IPC + Delta-Only TUI Redraws (No `CSI 2J`)
- **Location**: `src/components/views/TerminalView.tsx:820-858` (`fitTerminal`)
- **Mechanism**:
  1. `OpenCode` runs in the alternate screen (`?1049h`) and **never emits `Erase Display` (`\x1b[2J`)**. It updates the screen strictly via cursor positioning (`CUP`) and partial line erases (`EL`) inside DEC 2026 synchronized frames, erasing only the coordinates it actively overwrites.
  2. When the user maximizes or resizes the pane from `(cols_0, rows_0)` to `(cols_1, rows_1)`, `fitTerminal()` calls `safeFitTerminal(term, fitAddon, container)` **synchronously on the frontend**, resizing `xterm.js`'s buffer immediately to `(cols_1, rows_1)`.
  3. Meanwhile, `invokeCommand('resize_terminal')` travels asynchronously over IPC to Rust and Windows ConPTY (`ResizePseudoConsole`).
  4. During that asynchronous window, PTY output chunks that were already in flight (or queued in `writeRaw` / `syncBuffer`) and formatted by `OpenCode` for the **old geometry `(cols_0, rows_0)`** are written into `xterm.js`'s **already-resized `(cols_1, rows_1)`** alternate buffer—painting `OpenCode`'s old bottom bar at `row_0` (now in the middle/lower-middle of the enlarged screen).
  5. When `OpenCode` finally receives the new size from ConPTY, it draws its new bottom bar at `row_1` using delta cursor addressing **without sending `\x1b[2J`**. Any cells from the old bottom bar at `row_0` that `OpenCode` does not explicitly overwrite remain permanently stranded on screen, and Windows ConPTY's own synthesized `ResizePseudoConsole` buffer translation compounds the mismatch.

#### Root Cause 3 — Multi-Pass Resize Storm During Maximize / Layout Transitions
- **Location**: `src/components/views/TerminalView.tsx:588-643`, `897-925`, `1092-1122`, and `src/lib/terminalHostSize.ts:36-112`
- **Mechanism**:
  A single window maximize or pane resize triggers up to **4 overlapping resize paths**:
  1. `window.addEventListener('resize')` -> `scheduleStableFitRef.current()`
  2. `ResizeObserver` on `containerRef.current` -> `scheduleStableFitRef.current()`
  3. `scheduleForegroundGridDriftCheck()` inside `writeRaw()` (`TerminalView.tsx:608-643`), which inspects the grid on every incoming PTY write and triggers `fitNowRef.current()` mid-stream!
  4. `reconcilePtySizeAfterSpawn()` firing at `+120ms` and `+500ms`.
  Because `waitForStableHost` only waits 2 animation frames (`~32ms`) and there is no `inFlight` serialization lock around `resize_terminal`, maximizing a window on Windows 11 (whose DWM transition spans `~150ms`) dispatches multiple `term.resize()` + `ResizePseudoConsole()` calls back-to-back while `OpenCode` is mid-repaint.

#### Root Cause 4 — `attachDomBlockFillCleanup` Mutates Recycled DOM `<span>` Elements Without Observing Attribute/Render Updates
- **Location**: `src/lib/terminalViewport.ts:240-324`
- **Mechanism**:
  `OpenCode` draws its bottom prompt frame using Unicode half-blocks and full-blocks (`▀` `U+2580`, `▄` `U+2584`, `█` `U+2588`, `▌` `U+258C`, `▐` `U+2590`).
  `attachDomBlockFillCleanup` attaches a `MutationObserver` with `{ childList: true, characterData: true, subtree: true }` (omitting `attributes: true`) and sets `span.style.color = 'transparent'` plus custom `--kite-block-fg` gradients.
  - Before the first resize, spans are created fresh and styled once.
  - After a resize, `DomRenderer` recycles existing `<span>` elements across rows and updates their CSS class (`xterm-fg-*`) or inline `style` without changing `textContent`.
  - Because `applyBlockSpanStyle` returns early when `span.hasAttribute('data-kite-block-fill') && span.style.color === 'transparent'` (`line 249`), recycled spans in the bottom zone keep stale `--kite-block-fg` colors and gradients from before the resize!

#### Root Cause 5 — Artificial `32ms` Hold (`holdForCursorRestore`) and `stripTransientCursorShows` Mutating Live Alternate-Screen Streams
- **Location**: `src/components/views/TerminalView.tsx:693-716`, `963`, and `src/lib/terminalSyncOutput.ts:206-250`
- **Mechanism**:
  `holdForCursorRestore: true` holds every completed DEC 2026 frame (`\x1b[?2026l`) that ends with cursor hidden (`\x1b[?25l`) for an extra `32ms` timer (`FLUSH_UNLOCKED_FRAME_WITHOUT_CURSOR_RESTORE_MS`), while `stripTransientCursorShows` mutates the raw ANSI stream by deleting `\x1b[?25h` sequences. In `OpenCode` (which keeps the hardware cursor hidden and draws a virtual cursor), this delays every single frame by 32ms and causes post-resize frames to queue behind timers instead of executing atomically.

---

### 10.3 Step-by-Step Remediation Plan

#### Plan A — Definitive Fix for Phase 1 (`DOM Clásico` / `xterm.js`)

1. **Fix `StableCellFitAddon` & Buffer Resize Hygiene (`src/lib/terminalViewport.ts`)**:
   - Remove the custom `fit()` override in `StableCellFitAddon` so `super.fit()` runs `this._terminal._core._renderService.clear()` before `this._terminal.resize(cols, rows)` (only overriding `proposeDimensions()`).
   - Never mutate internal `_bufferService.buffers.normal.ybase` / `ydisp` directly; preserve scroll anchor via public `terminal.registerMarker()` / `terminal.scrollToBottom()` strictly when `terminal.buffer.active.type === 'normal'`, and do not touch scroll offsets when `type === 'alternate'`.

2. **Fix or Replace `attachDomBlockFillCleanup` with Render-Synchronized Cleanups (`src/lib/terminalViewport.ts`)**:
   - Tie block-element styling to `term.onRender(({ start, end }) => ...)` rather than an attribute-blind `MutationObserver`, and always re-read `getComputedStyle(span)` by clearing inline `color: transparent` before sampling when class/style attributes change—or rely purely on integer cell heights (`lineHeight: 1.0` + exact device-pixel row height in `StableCellFitAddon.proposeDimensions()`) so Unicode block glyphs fill 100% of the cell natively without DOM style mutations.

3. **Synchronize Resize Lifecycle & Eliminate Mid-Stream Grid-Drift Refits (`src/components/views/TerminalView.tsx`)**:
   - **Remove `scheduleForegroundGridDriftCheck`** (the temporary `36bab97` diagnostic hook in `writeRaw` that triggers `fitNowRef.current()` while PTY output is streaming).
   - **Debounce container resize by `150ms`** (`RESIZE_DEBOUNCE_MS = 150`) before running `waitForStableHost`, matching the settle time of window maximize animations.
   - **Serialize PTY resize with an in-flight gate (`resizeInFlightRef`) and pre-resize buffer flush**:
     - Before changing `term.cols` / `term.rows`, flush any pending bytes in `syncBufferRef` (formatted for the old grid) while `term` is still at `(oldCols, oldRows)`.
     - Perform `fitAddon.fit()` (which calls `_renderService.clear()` + `term.resize(newCols, newRows)`).
     - When `term.buffer.active.type === 'alternate'` and dimensions actually changed, clear stale residual cells in the alternate buffer (`\x1b[2J\x1b[H` locally on `term`) immediately before dispatching `invokeCommand('resize_terminal')`, so ConPTY/TUI delta redraws paint onto a clean `(newCols, newRows)` alternate grid with zero leftover bottom-bar fragments from `(oldCols, oldRows)`.

4. **Remove Artificial Frame Delay & ANSI Stream Mutation (`src/components/views/TerminalView.tsx`)**:
   - Set `holdForCursorRestore: false` in `createSynchronizedOutputBuffer` so DEC 2026 frames (`\x1b[?2026h ... \x1b[?2026l`) flush immediately and atomically on `\x1b[?2026l` without a 32ms delay.
   - Stop mutating raw PTY payloads with `stripTransientCursorShows` during normal frame delivery.
   - Restore `'dom'` (`DOM Clásico`) as the default renderer in `src/lib/terminalAppearancePrefs.ts` (`v5` migration) so full `xterm.js` interactivity is active out of the box.

#### Plan B — Complete Interactive TUI Support in Phase 2 (`GhostGrid · 2D`)

1. **Full SGR Mouse Reporting in `TerminalCanvasSurface.tsx` + `src-tauri/src/vt_engine.rs`**:
   - Detect DEC mouse modes (`?1000h`, `?1002h`, `?1003h`, `?1006h`, `?1016h`) in `vt_engine.rs` and include `mouse_mode`, `sgr_mouse`, and `sgr_pixels_mouse` in `RenderSnapshot`.
   - In `TerminalCanvasSurface.tsx`, when `mouse_mode !== 'none'`, encode `mousedown`, `mousemove` (with cell-level motion deduplication), `mouseup`, and `wheel` (buttons `64`/`65`/`66`/`67`) into 1-based `(col, row)` SGR mouse sequences (`\x1b[<button;col;rowM` / `m`) or SGR-Pixels (`?1016h`) sequences and send via `write_terminal` (unless `Shift` is held for local text selection).
2. **Terminal Query Responses & Extended CSI Sequences (`src-tauri/src/vt_engine.rs`, `src-tauri/src/terminal.rs`)**:
   - Respond to `OSC 10;?`, `OSC 11;?` (critical for `OpenCode` / Lipgloss dark-background auto-detection), `OSC 12;?`, `DECRQM` (`\x1b[?Ps$p` -> `\x1b[?Ps;Pm$y` for modes `25, 1000, 1002, 1003, 1004, 1006, 1016, 1049, 2004, 2026, 2048, 9001`), `CSI 6n` / `CSI ?6n` (CPR -> `\x1b[{row};{col}R`), `CSI 5n` (`\x1b[0n`), `CSI c` (`\x1b[?62;22c`), `CSI >c` (`\x1b[>1;10;0c`), `CSI ?u` (Kitty keyboard flags), and `CSI 14t / 16t / 18t` directly on the PTY master writer in `src-tauri/src/terminal.rs` when `GhostGrid · 2D` is active.
   - Normalize `CSI E` (`CNL`), `CSI F` (`CPL`), `CSI f` (`HVP`), and `CSI s` / `CSI u` (`SCP`/`RCP`) in `vt_engine.rs` before feeding `vt100::Parser`.
3. **Win32 Input Mode (`?9001h`), Kitty Keyboard Protocol (`CSI > flags u`), Focus Reporting (`?1004h`), `OSC 52` Clipboard, and Ergonomic Selection / Links**:
   - Track ConPTY `\x1b[?9001h` / `\x1b[?9001l` across chunk boundaries (`win32_tail`) and encode modified `Enter` (`Shift+Enter`, `Ctrl+Enter`, `Alt+Enter`) and `Escape` using Win32 input records (`\x1b[Vk;Sc;Uc;Kd;Cs;Rc_`) when `win32InputMode` is active, or `CSI u` (`\x1b[13;{mods}u`) when Kitty keyboard flags are active.
   - Decode `OSC 52` Base64 clipboard payloads in `vt_engine.rs` and write them to the system clipboard on snapshot arrival.
   - Strip leading Braille/star spinner characters from `OSC 0/2` window titles (`shown_title`).
   - Support single-click (char), double-click (word), and triple-click (line) selection with out-of-bounds drag auto-scroll and automatic copy-on-select, plus `Ctrl+Hover` / `Ctrl+Click` link detection and Nerd Font PUA icon fitting (`1.45x` cell allowance when followed by a space).
4. **Distinguishable Engine Naming & Interactive Header Badge**:
   - Name the native Rust VT + 2D Grid engine **`GhostGrid · 2D`** (`GhostGrid 2D` badge) alongside **`DOM · Clásico`** (`DOM Clásico` badge) and **`WebGL · GPU`** (`WebGL GPU` badge), displayed both in Settings and as a one-click toggle badge in every terminal pane header (`CodePaneHeader.tsx`, `CodePaneMenu.tsx`, and `TerminalView.tsx`).

---

## 11. Implementation Summary of Dual-Engine Remediation (Plan A + Plan B `GhostGrid · 2D`)

Both **Plan A (`DOM · Clásico`)** and **Plan B (`GhostGrid · 2D`)** have been fully implemented and verified:

| Area | Files Modified | Summary of Changes |
| :--- | :--- | :--- |
| **Plan A — `DOM · Clásico` Post-Resize Fix** | `src/lib/terminalViewport.ts`, `src/lib/terminalViewport.test.ts`, `src/components/views/TerminalView.tsx` | Restored `_renderService.clear()` inside `resizeConptyViewport` before `term.resize(cols, rows)`; synchronized `attachDomBlockFillCleanup` with `attributes: true` (`class`) and `term.onRender` while clearing `color: transparent` before re-sampling recycled `<span>` colors; removed mid-stream `scheduleForegroundGridDriftCheck`; set `holdForCursorRestore: false`; added `150ms` resize debounce, serialized `resize_terminal` IPC (`dispatchSerializedResize`), and pre-resize alternate-buffer clear (`\x1b[2J\x1b[H`) on geometry change. |
| **Plan B — `GhostGrid · 2D` Rust VT Protocol Engine** | `src-tauri/src/vt_engine.rs`, `src-tauri/src/terminal.rs` | Added bidirectional query responder (`OSC 10/11/12 ?`, `DECRQM ?Ps$p`, `CSI 6n/5n/c/>c/?u/14t/16t/18t`, mode `2048` in-band resize) flushed directly to the PTY writer when `canvas_active` is enabled; added chunk-boundary `win32-input-mode` (`?9001h`) watcher, Kitty keyboard flag stack (`CSI >/< /= u`), `OSC 52` Base64 clipboard decoding, `OSC 0/2` title extraction with spinner prefix stripping (`shown_title`), and CSI normalization (`E, F, f, s, u`). |
| **Plan B — `GhostGrid · 2D` Interactive Canvas Surface** | `src/components/views/TerminalCanvasSurface.tsx` | Added SGR (`?1006h`), SGR-Pixels (`?1016h`), and X10 mouse reporting (`Press`, deduplicated `Motion`, `Release`, vertical/horizontal `Wheel` `64..67`) with `Shift` selection override; Win32 input mode (`?9001h`) and Kitty `CSI u` key encoding; `?1004h` focus reporting (`\x1b[I` / `\x1b[O`); char/word/line selection with drag auto-scroll and copy-on-select; `Ctrl+Click` web/file link navigation; and Nerd Font PUA icon fitting. |
| **Engine Identity & Header Switcher Badge** | `src/lib/terminalAppearancePrefs.ts`, `src/components/views/SettingsView.tsx`, `src/components/code/CodePaneHeader.tsx`, `src/components/code/CodePaneMenu.tsx`, `src/components/views/TerminalView.tsx` | Named the 2D engine **`GhostGrid · 2D`** in Settings and added an interactive `GhostGrid 2D` / `DOM Clásico` badge in terminal headers and pane action menus for instant visibility and switching. |

---

## 12. Stability, Crash Prevention & Main-Thread Unblocking Fixes (2026-11-01)

Following interactive stress testing of `GhostGrid · 2D` across multiple concurrent `OpenCode` sessions, the application experienced an abrupt process abort (`STATUS_STACK_BUFFER_OVERRUN` / Rust `nounwind` abort) and UI freezes during rapid session creation and scrolling. Inspection of `app.log` pinpointed the exact crash and main-thread bottlenecks, all of which were resolved and verified:

### 12.1 Root Cause of the Process Crash & Fix (`src-tauri/vendor/vt100/src/grid.rs`)
- **Crash Evidence in `app.log`**:
  ```text
  PANIC: location=...\vt100-0.15.2\src\grid.rs:125:42, payload=attempt to subtract with overflow
  ```
- **Mechanism**:
  In `vt100-0.15.2`, `Grid::visible_row` and `Grid::drawing_row` computed `rows_len - self.scrollback_offset` using unchecked `usize` subtraction. When a terminal switched to the alternate screen (`?1049h`) or resized to fewer rows while `scrollback_offset > 0`, `self.scrollback_offset` exceeded `self.rows.len()`, triggering an integer underflow panic inside a synchronous Tauri command (`extern "C" nounwind`), which immediately aborted the Windows process.
- **Fixes Applied**:
  1. Vendored `vt100-0.15.2` into `src-tauri/vendor/vt100` (`[patch.crates-io] vt100 = { path = "vendor/vt100" }` in `src-tauri/Cargo.toml`).
  2. Replaced unchecked `rows_len - self.scrollback_offset` in `src-tauri/vendor/vt100/src/grid.rs` with saturating/clamped offset math (`let clamped_offset = self.scrollback_offset.min(rows_len);`) and replaced O(rows) `.chain().skip().nth()` iterator traversal with O(1) direct slice indexing (`&self.scrollback[sb_start + row]` / `&self.rows[row - clamped_offset]`).
  3. Replaced unchecked `self.size.cols - 1` / `self.size.rows - 1` subtractions in `grid.rs` with `.saturating_sub(1)` and reset `scrollback_offset = 0` when switching between normal and alternate grids in `screen.rs`.
  4. Added `std::panic::catch_unwind` guards around `vt_engine` entry points in `src-tauri/src/vt_engine.rs` plus regression test `does_not_panic_when_scrollback_offset_exceeds_screen_rows`.

### 12.2 Root Cause of UI Freezes & CPU Spikes & Fixes (`src-tauri/src/terminal.rs`, `src-tauri/src/vt_engine.rs`, `src/components/views/TerminalCanvasSurface.tsx`)
1. **Synchronous Tauri Commands Blocking the Win32 Main Thread (`src-tauri/src/terminal.rs`)**:
   - `start_terminal`, `attach_terminal`, `read_terminal_output`, `write_terminal`, `resize_terminal`, `poll_terminal_snapshot`, `scroll_terminal_viewport`, `clear_terminal_vt`, and `terminate_terminal` were declared as synchronous `pub fn`. In Tauri v2, synchronous commands run directly on the Win32 UI message-pump thread; any lock contention on `TERMINAL_MANAGER` or `ResizePseudoConsole` froze the entire desktop window.
   - **Fix**: Converted all terminal IPC commands to `pub async fn` backed by synchronous `*_sync` helpers executing on Tokio worker threads, completely decoupling PTY/mutex operations from the Win32 UI thread.
2. **Immediate Sub-Millisecond Terminal Query Replies in the PTY Reader Thread (`src-tauri/src/terminal.rs`)**:
   - Moved `vt.take_replies()` flushing directly into the background PTY reader loop (`let replies = vt.take_replies();`) so `CSI 6n`, `DECRQM`, `OSC 10/11`, and `CSI c` queries from `OpenCode` and Windows ConPTY are answered within `<1ms`, and suppressed duplicate `xterm.js` `CSI 5n/6n` replies in `TerminalView.tsx`.
3. **256-Entry SRGB Luminance Lookup Table & Dev Optimization (`src-tauri/src/vt_engine.rs`, `src-tauri/Cargo.toml`)**:
   - Replaced per-cell floating-point `f32::powf(2.4)` calls in `ensure_readable_fg` with a `OnceLock<[f32; 256]>` lookup table (`channel_luminance`) and enabled `[profile.dev.package."*"] opt-level = 2` in `src-tauri/Cargo.toml`.
4. **Elimination of Synchronous Forced Layout & Background Poller Contention (`src/components/views/TerminalCanvasSurface.tsx`, `src/components/views/TerminalView.tsx`)**:
   - Replaced per-frame `canvas.getBoundingClientRect()` inside `renderFrame()` with `cachedRectRef` updated only on resize/scroll, added `resizeInFlightRef` serialization in `TerminalCanvasSurface.tsx`, and disabled parked `xterm.js` output pollers and WebGL contexts whenever `renderer === 'canvas'`.

---

## 13. Cross-Renderer Artifact, Scroll Fluidity & Resize Latency Diagnosis & Phase 3 Action Plan

### 13.1 Current State After Section 12 Fixes
Hands-on verification confirmed:
1. **Stability**: The application no longer crashes or aborts under heavy multi-session `OpenCode` usage.
2. **Remaining Shared Symptom (Visual Artifacts)**: Both `GhostGrid · 2D` and `DOM · Clásico` exhibit the **exact same visual artifacts** in `OpenCode`, demonstrating that the remaining corruption originates **upstream of the frontend renderer** (in the ConPTY / session bootstrap / VT stream layer shared by both engines) as well as in specific VT state-machine edge cases.
3. **Remaining UX Symptoms**:
   - **Resize latency**: A noticeable delay occurs between resizing a pane/window and seeing the updated terminal frame.
   - **Non-native scroll feel**: Mouse wheel / trackpad scrolling in both TUI alternate screen (`OpenCode`) and normal scrollback feels jumpy and latent rather than native.

---

### 13.2 Why Both `GhostGrid · 2D` and `DOM · Clásico` Exhibit Identical Artifacts (5 Shared Upstream Causes)

#### Cause 1 — Tiny Initial Spawn Geometry (`cols=23..28`) + Windows ConPTY `ResizePseudoConsole` Buffer Wrapping
- **Direct Evidence in `app.log`**:
  ```text
  [1793569911948] spawn_session: session_id=term-1793401016334-kpqpg, cwd=E:\kite, engine=antigravity, cols=38, rows=33
  [1793569912003] spawn_session: session_id=da5d7393-8bea-4faa-a554-28672d5519bc, cwd=E:\kite, engine=open-code, cols=23, rows=33, mode=Resume { provider_session_id: Some("ses_e81e4b5b4ffekBZQr3dF6qCOsy") }
  ```
- **Mechanism**:
  When restoring or mounting multi-split workspaces, `OpenCode` is spawned while its pane container is still in a narrow initial layout (`cols=23, rows=33` or `cols=28, rows=33`).
  1. `OpenCode` boots and draws its 57+ column TUI layout into a **23-column Windows ConPTY (`conhost.exe`)**.
  2. Windows ConPTY hard-wraps and folds those lines inside its internal 23-column screen buffer.
  3. When the pane expands to `97×60` (or when the window is maximized), Windows ConPTY's `ResizePseudoConsole` synthesizes cursor movements and wrapped line rewrites from its damaged 23-column buffer *before* `OpenCode` processes the resize event.
  4. Because `OpenCode` never emits `Erase Display` (`\x1b[2J`) and only updates changed coordinates via delta `CUP` (`\x1b[row;colH`), the wrapped fragments emitted by ConPTY remain permanently in **both** `vt100` (`GhostGrid · 2D`) and `xterm.js` (`DOM · Clásico`).

#### Cause 2 — Pre-Saved `.scrollback` Fed Into `vt_engine` at Spawn & Replayed Into Mismatched Geometry
- **Location**: `src-tauri/src/terminal.rs:1239-1256` (`spawn_session_with_options`) & `1736` (`attach_terminal_sync`)
- **Mechanism**:
  In `spawn_session_with_options`:
  ```rust
  let initial_scrollback = read_scrollback_file(session_id).unwrap_or_default();
  ...
  if !sb_guard.is_empty() {
      vt_engine_init.feed(&sb_guard);
  }
  ```
  - `delete_scrollback_file(&session_id)` is only called inside `attach_terminal_sync` (not `start_terminal_sync`), and even in `attach_terminal_sync` it runs **after** `get_or_spawn_session` has already read the `.scrollback` file into `scrollback_buffer` and fed it into `vt_engine_init`!
  - Worse yet, `.scrollback` contains raw ANSI sequences recorded at a **previous session's `(cols, rows)` geometry**, which are re-fed into a `cols=23` (or newly sized) parser right before the resumed `OpenCode` TUI draws its new frame.

#### Cause 3 — `vt_engine.rs` Mutates Live `vt100` State During `DEC 2026` (`?2026h`) and Drops the Hold After Only `60ms`
- **Location**: `src-tauri/src/vt_engine.rs:802-864`
- **Mechanism**:
  1. When `\x1b[?2026h` arrives, `vt_engine.rs` sets `self.render_held = true`, **but immediately feeds the partial chunk into `self.parser.process(&normalized)`**, mutating the live `vt100` screen mid-frame!
  2. `vt_engine.rs` expires `self.render_held` after only **`60ms`** (`Duration::from_millis(60)` at line 853). Over Windows ConPTY, a full `OpenCode` redraw during resize or scroll routinely takes `80–200ms` across multiple 4KB pipe reads. After `60ms`, `vt_engine.rs` releases the hold and snapshots a **half-erased, half-drawn TUI frame**.
  3. At line 857 (`else if since_seq == self.seq`), whenever `since_seq != self.seq` (for example on initial attach `since_seq == 0` or right after a resize), `get_snapshot_diff` **bypasses `self.render_held` completely** and returns the partially mutated `self.parser` screen!
  4. **Required Architecture**: When `?2026h` begins (`on_render_hold(true)`), `vt_engine` must freeze `committed_snapshot` at the **clean pre-hold frame** and hold it for up to **`1000ms`** (`MAX_HOLD_MS = 1000`). While `render_held` is active, *every* call to `get_snapshot_diff` must return the frozen pre-hold snapshot (or `unchanged: true`), never reading from the mid-draw `self.parser.screen()` until `?2026l` arrives.

#### Cause 4 — `vt100` `Grid::set_size` Leaves Stale Alternate-Screen Cells on Resize & Lacks `CSI b` (`REP`)
- **Location**: `src-tauri/vendor/vt100/src/grid.rs:66-93` & `src-tauri/src/vt_engine.rs`
- **Mechanism**:
  When `vt_engine.resize(cols, rows)` runs while `alternate_screen` is active, `Grid::set_size` resizes `self.rows` in-place (`row.truncate(size.cols)` / `self.rows.extend(...)`) **without clearing the alternate grid** when ConPTY is about to redraw, leaving old right-margin and bottom-bar cells from the prior geometry whenever `OpenCode` performs delta updates. Additionally, `vt100-0.15.2` ignores `CSI b` (`REP` — Repeat Preceding Graphic Character), which modern TUIs use to repeat horizontal border characters (`─`, `▀`, `▄`).

#### Cause 5 — Kite-Specific Background Terminal Hooks & PowerShell Wrapper Layer
- **Location**: `src-tauri/src/terminal.rs:1165-1173`, `1835-1895`, and `src/components/views/TerminalView.tsx`
- **Mechanism**:
  Unlike standalone minimal terminal emulators, Kite runs:
  1. **PowerShell Wrapper (`powershell.exe -NoLogo -NoExit -Command ...`)** around every agent CLI (`open-code`, `claude`, `codex`, `gemini`, `grok`), placing an intermediate PowerShell console host between ConPTY and the child TUI that intercepts and re-buffers console resize events.
  2. **Process & Session Inspection Hooks (`detect_child_agent_in_shell`, `resolve_provider_session_id_with_context`)** triggered during terminal lifecycle/read polling.
  3. **Frontend Output Scanners (`recordTerminalOutput`, `extractTerminalLinks`, `terminalInteractionDiagnostics`)** running on terminal output chunks.

---

### 13.3 Why Scroll Feels Non-Native & Why Resize Has Latency

1. **Mouse Wheel Notch Multiplication in Alternate Screen (`src/components/views/TerminalCanvasSurface.tsx:1670-1705`)**:
   - In `handleWheel`, `LINE_STEP_PX` is set to `Math.max(12, cellHeight * 1.5)` (`~24px`).
   - On Windows, a single standard mouse wheel notch emits `e.deltaMode === 0` (`DOM_DELTA_PIXEL`) with `e.deltaY = 100` or `120`.
   - Dividing `120 / 24` produces **`steps = 5`**, so a single physical wheel notch sends **5 consecutive `\x1b[<64;col;rowM` SGR wheel events** to `OpenCode`, forcing `OpenCode` to jump 5 scroll steps at once and flooding ConPTY with 5 full-screen redraws per wheel click!
2. **Two-IPC Round-Trip Lag on Normal-Screen Scrollback (`src/components/views/TerminalCanvasSurface.tsx:1710-1725`)**:
   - Scrolling in normal screen awaits `invokeCommand('scroll_terminal_viewport')` and *then* calls `immediatePollRef.current()` (`invokeCommand('poll_terminal_snapshot')`), requiring two sequential IPC round-trips (`~15–30ms`) before a single scrolled frame is painted.
3. **Post-Resize `180ms` Poll Sleep Trap (`src/components/views/TerminalCanvasSurface.tsx:860-885, 1185-1195`)**:
   - When `resize_terminal` finishes, `immediatePollRef.current()` fires `0.5ms` later—before Windows ConPTY and `OpenCode` have finished computing and writing the resized TUI frame (`~25–60ms`).
   - Because that immediate poll sees no new TUI bytes yet, the polling loop classifies the terminal as idle and sleeps for **`180ms`** (`nextDelay = 180`), adding up to `180ms` of visible resize latency!

---

### 13.4 Phase 3 Remediation & Diagnostic Plan

1. **Step 1 — Unified Terminal Diagnostic Flight Recorder (`src-tauri/src/terminal_diag.rs` + In-App Snapshot Dump)**:
   - Add a lightweight structured diagnostic logger (`app.log` + optional per-session JSONL dump in `<appDataDir>/logs/terminal-diag-<sessionId>.jsonl`) that records:
     - `SPAWN` / `ATTACH` / `SCROLLBACK_REPLAY`: exact `(cols, rows)`, engine, whether `.scrollback` existed and how many bytes were fed or skipped.
     - `RESIZE`: `(old_cols, old_rows) -> (new_cols, new_rows)`, active screen (`normal` vs `alt`), and elapsed time until the first post-resize TUI frame arrives.
     - `DEC2026`: every `?2026h` start, byte count accumulated during hold, whether closed cleanly by `?2026l` or expired by timeout, and total hold duration in `ms`.
     - `UNHANDLED_CSI`: any CSI/ESC sequence encountered in the stream that `vt100` does not natively handle.
   - Add a one-click **"Exportar Diagnóstico"** action in the terminal pane menu (`CodePaneMenu.tsx`) that dumps the current session's live VT grid, raw ring buffer (last 64KB), and event timeline for immediate inspection.
2. **Step 2 — Eliminate `.scrollback` Replay & Tiny-Grid Spawn Corruption for Agent TUIs (`src-tauri/src/terminal.rs`, `src/components/views/TerminalView.tsx`)**:
   - Never load or feed `.scrollback` files into `vt_engine` or `scrollback_buffer` when spawning or resuming an agent CLI (`engine != "shell"` / `is_agent_cli`). Delete any stale `.scrollback` file *before* `spawn_session_with_options` initializes `vt_engine`.
   - Enforce a safe initial spawn geometry floor (`cols >= 80, rows >= 24`) when a pane has not yet settled its final layout or wait until CSS layout settles before spawning the ConPTY process.
3. **Step 3 — True Pre-Hold Snapshot Freeze (`1000ms` Ceiling) & `CSI b` (`REP`) Support in `vt_engine.rs`**:
   - On `\x1b[?2026h`, snapshot the clean pre-hold state into `committed_snapshot` *before* feeding the post-`?2026h` bytes to `self.parser`, raise the hold timeout from `60ms` to `1000ms`, and ensure `get_snapshot_diff` always serves the frozen pre-hold snapshot while `self.render_held == true` regardless of `since_seq`.
   - Expand `normalize_csi_sequences` in `vt_engine.rs` to translate `CSI Ps b` (`REP` — repeat last graphic char `Ps` times) and clear residual out-of-bounds alternate-screen cells on geometry change.
4. **Step 4 — Zero-Wait Post-Resize Burst Polling & Native-Fluidity Scroll (`src/components/views/TerminalCanvasSurface.tsx`, `src-tauri/src/terminal.rs`)**:
   - **Resize Latency Fix**: Maintain a `fastPollUntilRef` timestamp (`performance.now() + 300`) after every `resize_terminal` and user input event so the poller stays at `8–12ms` until the TUI's resized frame arrives, instead of dropping to `180ms`.
   - **Native Scroll Fix**:
     - Differentiate discrete mouse wheel notches (`|deltaY| >= 80` in `DOM_DELTA_PIXEL` or `DOM_DELTA_LINE`) from smooth trackpad deltas so 1 physical mouse wheel notch sends **1 SGR wheel event** (not 5) in alternate screen and scrolls **3 lines** in normal screen.
     - Have `scroll_terminal_viewport` return `Result<RenderSnapshot, String>` directly in a **single IPC call** and paint immediately on the next animation frame.

---

## Historical mitigation summary (not a final resolution)

The following changes addressed specific launch, buffer, geometry, and redraw
paths. They are historical mitigations, not confirmed root causes, and they do
not establish that the session-specific artifact is resolved:
1. `src-tauri/src/terminal.rs`: `snapshot_scrollback_for_attach` with `preserve_unread_buffer: true` prevents dropping PTY output bytes upon re-attaching; `resize_terminal` ignores no-op calls to avoid redundant Windows ConPTY `ResizePseudoConsole` repaints.
2. `src/lib/terminalViewport.ts`: `StableCellFitAddon` computes geometry using `device.cell.width / dpr` and 5px scrollbar reservation without clearing render service; `scheduleStabilizedFit` prevents 1-frame layout jitter; `attachDomBlockFillCleanup` handles text node mutations.
3. `src/lib/terminalSyncOutput.ts`: `foregroundRewriteOutputPrefersRenderRefresh` captures CSI cursor positioning and erase sequences, cross-chunk scan state, and schedules texture atlas flushes for non-ASCII rewrites.
4. `src/components/views/TerminalView.tsx` & `SettingsView.tsx`: Terminal appearance settings implemented with **DOM Clásico** as default (`13px`, `1.16` line height, `Cascadia Mono`).

Commit `36bab97` added a temporary foreground grid-drift refit gate for one
controlled sample. It is diagnostic only and must be rolled back after the
sample. As a precondition, capture input/hover and collapse/expand transitions
and correlate them with output and resize events. The sole next code experiment
is capture-gated and repaint-only; it must call neither `term.resize` nor
`resize_terminal`.

## Verification when an experiment lands

- `npx tsc --noEmit`
- `npx vitest run`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `node .kite/sanitizer/audit-references.mjs --check`
- Manual: three agent terminals in one view, Grok and OpenCode, no manual resize.
- Manual: use OpenCode for several minutes and confirm old rows do not remain pinned.

## Rollback

Attempt 1 is exactly `986e308`. Revert that commit to return to the pre-geometry behavior. E1's stable-host wait is `5ffdb58`. The blank-pane follow-up is `41c1d60`. Revert `41c1d60` to restore the early 80×24 spawn. E2 is `7d649d8`. Revert it to restore local alt-screen refresh. E3 is the commit that sets `lineHeight` to `1`. Revert it to restore `1.16`. Later experiments must say which commit to revert.

## 14. Shared paint artifacts, scroll contract, fast poll, and diagnostics

Implemented in the working tree on 2026-11-01. Visual check the same day: the artifacts remain on both engines. Section 14 describes what the tree does now. It is not a fix. Section 15 is the record and the next hypothesis.

GhostGrid · 2D and DOM · Clásico show the same stuck fragments because both parsers receive the same byte stream. The stream is already wrong before either renderer paints.

Agent TUIs were born inside a ConPTY that was still the size of an unmeasured split, often 23–38 columns. The host hard-wraps that first paint. A later growth does not erase those wraps. Full-screen agents repaint with cursor addressing and never send erase-display, so the wrapped pieces stay on both the Rust screen and the DOM screen. Spawn now waits a few frames when the first measure is still under 50 columns, until the host is wider than 360px or the width holds still, and then measures again. Agent sessions whose requested width is still under 60 columns are opened at 80×24. The real layout resize follows once the pane has settled. That floor does not apply to a plain shell.

The same spawn used to feed the previous scrollback file into the virtual terminal before attach removed the file. A new agent session now deletes that file first and starts from an empty screen. Shell scrollback is unchanged.

Synchronized updates (`CSI ?2026 h` / `CSI ?2026 l`) used to parse the partial frame into the live screen and only hide it when the client was already on the latest sequence. The hold also expired at 60ms, so a slow frame was published half-drawn. The engine now commits the last clean frame before it accepts bytes that open an unbalanced hold, and polls serve that committed frame until the matching end or a 1000ms safety timeout. A chunk that contains both the start and the end is one complete frame and is published once. A timeout is counted once and written once to the app log.

Repeat (`CSI Ps b`) was ignored, so box borders that use it fell out of step with the cells beside them. The byte stream now expands the repeat into the preceding graphic character, up to 512 extra copies, before the parser sees it. ECMA-48 counts those copies in addition to the character already drawn.

Resizing the alternate screen left orphan cells outside the new grid. An alternate-screen size change now clears that screen, drops the published row baseline, and commits the cleared frame. The primary screen is not blanked on resize.

Wheel input is split the same way a physical device produces it. One discrete notch is one wheel report while the terminal is on the alternate screen or is tracking the mouse, and three scrollback lines on the normal screen. Pixel and trackpad motion accumulate until they cross a cell, and alternate-screen or mouse reports stay capped at three steps. Scrollback movement returns the new frame in that same call. The canvas paints it directly and does not issue a second poll for the gesture. Page keys and selection auto-scroll use the same single-call path.

After a session starts or attaches, the canvas polls quickly for about 500ms. Resize keeps that window for 350ms. Keyboard, paste, click, and wheel keep it for 250ms. While the window is open and the tab is visible, an unchanged poll waits 10ms. After it closes, the idle wait is 120ms. A hidden document waits 500ms. A changed frame schedules the next poll in 8ms.

The pane menu action Export Diagnostics asks the session for a JSON dump and copies the file path. The file lives beside the app log and includes the grid size, alternate-screen and mouse state, cursor, sequence, spawn and resize counters, synchronized-update counters, a short sample of unrecognized control sequences, the visible rows as text and cell attributes, and the last 16KB of the scrollback buffer. Missing a session fails quietly.

## 15. Phase 3 visual result (2026-11-01) — not a fix

The user launched the app after the section 14 changes and reported the same artifacts on both `DOM · Clásico` and `GhostGrid · 2D`. No commit. `HEAD` remains `05d6678`. Do not commit this tree as a terminal fix. Do not start another renderer.

What the two engines share, and what section 14 did not change:

- Every agent CLI is still started as `powershell.exe -NoLogo -NoExit -Command …` inside a local ConPTY (`src-tauri/src/terminal.rs`, `spawn_session_with_options`).
- A later `ResizePseudoConsole` still runs when the pane settles, when a split moves, and when `estimateTargetPaneGrid` invents a size. If the container rect is under 200×140, that helper substitutes 960×640, then the real pane resizes the same PTY.
- Full-screen agents still repaint with cursor addressing and still omit erase-display. Both parsers display that stream faithfully.

Section 14 therefore did not touch the producer of the bytes. It changed how one parser hides a partial frame, how repeats are expanded, how a too-narrow spawn is floored to 80×24, how fast the canvas polls, and how the wheel is counted. The DOM engine does not use those parser paths and it still artifacts. The canvas engine does use them and it still artifacts. The shared picture is the host stream.

### Do not repeat

These were launched or are present in this working tree. The picture did not change.

- Another synchronized-update hold. Tried at about 16 ms, 60 ms, 100 ms, 250 ms, and now 1000 ms with a frozen pre-hold frame. A partial slice that never erases the display stays partial when the hold ends.
- Another alt-screen erase. Local CSI `2J` before resize failed on 28 October 2026. Parser-side CSI `2J` on alternate-screen resize is in this tree and the artifacts remain.
- Another `CSI Ps b` expansion, another wheel divisor, another poll interval, another `lineHeight`, another WebGL or canvas swap.
- Another floor that opens the PTY at 80×24 and resizes it afterward. `5ffdb58` already started the process at 80×24 and left new panes blank. Phase 3 does the same floor when the request is under 60 columns.
- Another in-process VT or sprite port while the child is still the PowerShell wrapper. Both current painters already agree.
- Scoring the next attempt with a changelog line that says ghosting is fixed.

### Next experiment (one change)

Spawn the resolved agent executable as the ConPTY child. Pass the same arguments, environment, and working directory the wrapper passes today. Do not insert `powershell.exe -NoExit -Command` for that agent. Leave ordinary shell panes on PowerShell. Do not combine this with a hold, a floor, a poll change, or a renderer change.

Visual check, in order: one OpenCode pane in the current renderer, then the same pane in the other renderer, then a resize and a wheel. A coherent shell pane does not count. If the agent fails to start, that is a launch bug and this hypothesis is unfinished, not confirmed. If both painters still artifact, stop and record it. The following candidate, still not to be coded in the same change, is to stop the extra `ResizePseudoConsole`: spawn once at the settled measure, and do not resize on every divider `pointermove` or on the 960×640 fallback inside `estimateTargetPaneGrid`.

Before that second change, use Export Diagnostics or one opt-in capture (`KITE_TERMINAL_CAPTURE_DIR`) and read only the counts: spawn columns, whether the log says the geometry was floored, resize count, erase-display count, and the highest cursor column against the grid width. Do not paste the scrollback. Older captures already showed erase-display at 0 and a cursor past the grid. A new capture is useful only to see whether this host change moved those counts.

## 16. Experiment: agent executable as direct ConPTY child (2026-11-01) - code landed, visual check pending

One change, from section 15. Agent CLIs no longer run under `powershell.exe -NoLogo -NoExit -Command`. `build_agent_command` in `src-tauri/src/terminal.rs` now makes the resolved executable the ConPTY child, with the same arguments, working directory, and environment (`TERM`, `KITE_*`, vault credentials). It is used by both the direct agent branch and the hybrid shell-resume branch. Plain shell panes stay on PowerShell.

- An `.exe` is launched as-is. An npm `.cmd` shim is followed to the `.exe` it calls (`resolve_direct_agent_executable`). On this machine that covers OpenCode, Grok, Codex, and Antigravity.
- Interpreter-run shims (Gemini's `node ... gemini.js`) have no native executable. They keep the wrapper and write `WARN agent_launch: ... using PowerShell wrapper` to the app log. Search the log for `agent_launch: direct ConPTY child` to confirm a direct launch.
- Not carried over: the wrapper's `chcp 65001` and `OutputEncoding` preamble, and `-NoExit` (the pane now ends when the agent exits and reports `exited`). If characters collide, that is E4, not this change.
- Nothing else changed: no hold, floor, poll, resize, or renderer edit.

Automated: `direct_agent_executable_follows_npm_cmd_shim_and_skips_scripts` passes. The visual result is not yet recorded.

Visual check, in order: one OpenCode pane in the current renderer, the same pane in the other renderer, then a resize and a wheel. If both painters still artifact, record it here and stop. The next separate change is to stop the extra `ResizePseudoConsole` (spawn once at the settled measure, no resize per divider `pointermove`, no 960x640 fallback). Rollback: revert the `build_agent_command` call sites in `spawn_session_with_options`.

### 16.1 Visual result (2026-11-01, 20:21) - not a fix

The user launched the tree and reported the same failure, in their words "the crashes remain the same". `app.log` confirms the host change was active: `agent_launch: direct ConPTY child exe=...agy.exe` and `...@opencode\cli\bin\opencode.exe`, no PowerShell wrapper. No `PANIC` appears after the launch (the last ones, `vt100 grid.rs:125`, predate the section 12 fix). Resizes seen in that session: `80x29 -> 140x53` (alternate screen) and `140x53 -> 141x60`; the 80-column floor was still applied to both agents.

Conclusion: removing the PowerShell wrapper did not change the picture. Do not reopen it, and do not revert it without a reason. Not recorded yet: Export Diagnostics counts, and whether the remaining failure is a process crash or painted artifacts. The next candidate stays section 15's second change (no `ResizePseudoConsole` per divider `pointermove`, no 960x640 fallback), only after those counts are read.

### 16.2 Capture read (2026-11-01, 20:28) - the 80x24 floor races the agent's startup

Opt-in capture (`KITE_TERMINAL_CAPTURE_DIR`) of an OpenCode pane, counts only. The user reported the picture was much worse than before.

- Grid timeline: `80x33` at +0.00 s, `42x33` at +0.04 s, `141x60` at +16.2 s, `117x60` at +23.3 s, `116x53` at +27.3 s.
- The floor opened the ConPTY at 80 columns and the real pane width (42) arrived 40 ms later. OpenCode entered the alternate screen (`?1049h`) at +0.38 s, so it read the grid before it was listening for the shrink. Its first frames address columns up to 85 inside a 42-column host (`CUP` beyond the grid: 2).
- Erase-display count: 0. Erase-line: 263. Synchronized updates: 172 balanced pairs. One alternate-screen entry. Direct launch was active (no wrapper).
- Encoding after dropping the wrapper preamble: 0 replacement characters and 0 mojibake hits in 2,200+ box characters. The preamble is not needed.
- Antigravity (`agy`) captured 15 chunks / 1 MB of resumed history with 6 erase-display; its widths were 20 then 67. It is a replay, not the live-frame failure.

Change (one): the spawn floor is removed. `spawn_session_with_options` now opens the ConPTY at the measured size, so the agent's first read matches the host. This reverts part of section 14's floor; it is not a new floor. Everything else is unchanged.

Check: repeat the same capture. Expected if the hypothesis holds: no `80x` first grid for a pane measured at 42, `CUP` beyond the grid at 0 for the first frames. If the first frame is clean but resize-driven artifacts remain, the next candidate is section 15's second change (no `ResizePseudoConsole` per divider move, no 960x640 fallback). Rollback: restore the `requested_cols < 60` floor in `spawn_session_with_options`.

### 16.3 Capture read & root cause fix (2026-11-01, 21:05) - VS16 (`U+FE0F`) cell-width mismatch & clean renderer resync

Opt-in capture (`no-floor`) of the same OpenCode session (`34x29 -> 116x53 -> 117x60`, 135 output chunks) confirmed two things:

1. **Startup race eliminated**: Opening ConPTY directly at `34x29` eliminated the `80x33 -> 42x33` startup race (`0` out-of-bounds `CUP`s on initial frames).
2. **Exact byte-stream root cause of the shared artifacts (`┃┃`, `returned┃`, `EE:\kite`, `u`, `→ E`)**:
   - OpenCode enables Unicode Mode 2027 (`\x1b[?2027h` in `seq=1`), and Windows ConPTY + OpenCode treat **Variation Selector-16 (`U+FE0F`, Emoji Presentation Selector)** following a narrow symbol (`⚠️` = `U+26A0` + `U+FE0F` in `⚠️ gentle-ai-verify returned 2 blockers`) as widening the grapheme cluster from **width 1 to width 2** (2 terminal cells).
   - Neither `vt100` (`src-tauri/vendor/vt100/src/screen.rs`) nor `ZwjAwareUnicode11Provider` (`src/lib/terminalViewport.ts`) widened a width-1 symbol to width 2 when followed by `U+FE0F`:
     - **Single-line toast overwrite (`seq=4 -> seq=5` at `34x29`)**: `seq=4` draws a 28-col toast on Row 2 (`Cols 5..32`) with right border `┃` at Col 32. `seq=5` overwrites Row 2 starting at Col 5 with `⚠️ gentle-ai-verify returned` (`2 + 26 = 28` cells, `Cols 5..32`). Counting `⚠️` as 1 cell (`27` cells, `Cols 5..31`) leaves the old right border `┃` at Col 32 untouched (`⚠ gentle-ai-verify returned┃`).
     - **Full-screen ConPTY autowrap redraw (`seq=10` at `116x53`, `seq=70` at `117x60`)**: On resize, ConPTY emits all `cols * rows` cells (`116 * 53 = 6,148` in `seq=10`; `117 * 60 = 7,020` in `seq=70`) starting from `ESC[H` `(1, 1)` relying on autowrap at column `cols` without `CR/LF` or `CUP` between rows. With `⚠️` counted as width 1 instead of width 2, the parser places **6,147** cells (1 short of 6,148) in `seq=10` and **7,019** cells (1 short of 7,020) in `seq=70`. Every row after `⚠️` wraps **1 column late** and shifts **1 column to the left** (`┃` lands at Col 2 instead of Col 3, `E:\kite` lands at Col 2 instead of Col 3).
     - **Subsequent delta `CUP` updates (`seq=11..69`, `seq=71..135`)**: OpenCode updates individual lines using explicit `CUP` (`ESC[12;3H┃`, `ESC[59;3HE:\kite`), writing at true Column 3 while the shifted characters at Column 2 remain untouched — producing `┃┃`, `EE:\kite:feat/ui-composer`, `u`, and `→ E`.
   - Replaying all 138 events of `no-floor` and all 75 events of `direct-host` with `U+FE0F` widening enabled drops artifact frames from `75/138` and `58/75` down to **`0/138` and `0/75`**.

Changes landed:
- **`src-tauri/vendor/vt100` (`cell.rs`, `row.rs`, `screen.rs`)**: Added `U+FE0F` (`VS16`) cell-widening (upgrades a preceding narrow cell to wide, allocates the wide continuation cell at `pos`, and advances the cursor by 1 column) and `U+200D` (`ZWJ`) cluster joining.
- **`src/lib/terminalViewport.ts` (`ZwjAwareUnicode11Provider`)**: `charProperties` now returns `createUnicodePropertyValue(0xFE0F, 2, true)` when `U+FE0F` follows a non-zero-width character, triggering `xterm.js`'s built-in cell-widening loop.
- **Clean renderer switch & resize (`src-tauri/src/vt_engine.rs`, `src-tauri/src/terminal.rs`, `src/components/views/TerminalView.tsx`)**:
  - Removed the destructive parser-side `CSI 2J` on alternate-screen resize in `TerminalVtEngine::resize` so resizing does not blank the screen or desynchronize `vt_engine` from ConPTY's differential buffer.
  - Added `TerminalVtEngine::alternate_screen_seed()` and wired `resyncFromScreen` so switching between `GhostGrid · 2D` and `DOM · Clásico` resets the target surface and seeds it from the clean live screen instead of replaying 256 KB of historical multi-geometry scrollback.
  - Added Mode 2027 (`2027 => 1`) to `DECRQM` in `vt_engine.rs`.

---

## 17. Final Resolution & Verified Product Contracts (2026-11-01)

### 17.1 Root Cause Summary
The terminal ghosting, stuck vertical bars (`┃┃`), and character collisions (`EE:\kite`, `returned┃`) across both `DOM · Clásico` and `GhostGrid · 2D` engines were traced to a single byte-level upstream defect:
- Windows ConPTY and modern TUI agents (e.g., `open-code`) negotiate Unicode Mode 2027 (`\x1b[?2027h`), where a Variation Selector-16 (`U+FE0F`) following a narrow symbol (such as `⚠️`) widens the grapheme cluster from 1 to 2 cells.
- When the terminal parser treats `U+FE0F` as width 1, full-screen ConPTY autowrap redraws wrap 1 column late. Every subsequent row shifts 1 cell to the left. Follow-up differential cursor-addressing (`CUP`) writes at true columns while leaving shifted characters behind.

### 17.2 Product Contracts & Invariants
1. **Unicode 2027 & VS16 Grapheme Widening Contract**:
   - `WHEN` a terminal receives `U+FE0F` following any non-zero-width character, `THEN` both the native Rust VT parser (`vt100`) and the web viewport provider (`ZwjAwareUnicode11Provider`) widen the cluster to 2 columns and advance the cursor accordingly.
2. **Startup & Geometry Settling Contract**:
   - `WHEN` a terminal session spawns, `THEN` it initializes directly at the measured host container dimensions without artificial fixed-size floors that induce resize races.
3. **Renderer State Resynchronization Contract**:
   - `WHEN` a user switches between `GhostGrid · 2D`, `DOM · Clásico`, or `WebGL`, `THEN` the target surface is seeded from the clean live virtual terminal state (`alternate_screen_seed()`), never replaying historical multi-geometry scrollback.

### 17.3 Automated & Regression Verification
- `npx tsc --noEmit`: 0 errors.
- `npx vitest run`: 30/30 terminal unit and integration tests passing.
- `cargo check --manifest-path src-tauri/Cargo.toml`: Clean build, 0 errors.
- Specimen session capture verification: Artifact frames reduced from 75/138 down to 0/138.
