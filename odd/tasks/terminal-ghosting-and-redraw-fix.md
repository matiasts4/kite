# Terminal Ghosting Elimination, Geometry Synchronization & Redraw Engine

Objective: Eliminate visual ghosting, overlapping text, and stuck banner artifacts in ConPTY terminal sessions (notably interactive TUIs like OpenCode, Claude Code, and agent panes) caused by initial geometry desynchronization, CSS scale transform during mount, and delayed resize notifications.
Branch: `feat/ui-composer` (working branch; isolated commits for easy inspection and rollback).
Test runner: `npx vitest run`; typecheck: `npx tsc --noEmit`; audit: `node .kite/sanitizer/audit-references.mjs --check`.

---

## 1. Context & Problem Statement

### Observed Symptom
In terminal panes running interactive CLI agents or TUIs (such as `OpenCode` or agent sessions), visual artifacts ("ghost text") appear on screen:
- Banners, tables (such as shortcuts tables `Terminal & Código | Guardar archivo activo | Ctrl+S / Cmd+S | Activo`), or status indicators from previous steps remain frozen at the top or overlaid across newer command outputs (`### 3. Verificación de calidad y tests...`).
- When the user manually resizes or expands the terminal pane, all ghost artifacts vanish immediately and the true screen renders cleanly.
- Switching away (e.g. to Agent or Thread view) and back to Code also temporarily clears the artifacts because the terminal element is reparented and `fitTerminal` is retriggered.

### Root Cause Analysis

1. **Initial ConPTY Geometry Desynchronization (80×24 Default vs. Real Pane Width)**:
   - When `start_terminal` was invoked, ConPTY was spawned with a fallback of 80 columns and 24 rows before the container DOM layout had settled or before `fitAddon.fit()` had inspected the actual container width.
   - For split panes and agent panels (typically 50–65 columns wide), OpenCode starts running immediately, outputting headers, tables, and banners formatted for an 80-column terminal.
   - Because `xterm.js` has only ~60 columns, it soft-wraps 80-character lines across multiple visual lines.

2. **Broken ANSI Relative Cursor Positioning on Soft-Wrapped Lines**:
   - Interactive TUIs like OpenCode update the screen in-place using ANSI escape sequences such as `\x1b[1A` (cursor UP 1 line) and `\x1b[2K` (clear line).
   - When OpenCode prints an 80-char line, it believes it occupies 1 logical line.
   - In xterm, that line wrapped onto 2 lines. When OpenCode moves the cursor up 1 line to erase it, the cursor lands on line 2 (the wrapped tail) rather than line 1.
   - Line 1 is never erased. It stays in the xterm buffer permanently as an orphan "ghost line".
   - Subsequent outputs print beneath or over these orphan lines, causing overlapping text.

3. **Subpixel Measurement Distortion from CSS Scale Animation**:
   - `terminal.css` declared `@keyframes terminal-view-fade-in` with `transform: scale(0.995)` to `scale(1)`.
   - During the 200ms animation, `fitAddon` measures character cell dimensions (`_charSizeService.measure()`) via `getBoundingClientRect()`.
   - The CSS transform causes fractional pixel widths (e.g., 7.96px instead of 8.00px), corrupting cell dimensions and resulting in incorrect column/row calculations during initial render.

4. **100ms Debounce Lag on ConPTY Resize**:
   - In `TerminalView.tsx`, `fitTerminal` used a 100ms timer to debounce resize calls to ConPTY.
   - During those 100ms, `xterm.js` was already resized to the pane width, but ConPTY and the spawned CLI were still running at 80 columns. The initial banner was outputted and corrupted during this 100ms window.

5. **Scroll Restoration on Alternate Screen Buffer**:
   - `restoreScroll()` indiscriminately called `scrollToBottom()` and `scrollToLine()` multiple times during resize, even when the terminal was in the alternate screen buffer (`term.buffer.active.type === 'alternate'`) where `baseY === 0`, inducing viewport shifts while the TUI was actively painting.

---

## 2. Technical Specifications (S1–S5)

### S1. Neutral Mount Animation (Eliminate CSS Scale Transform)
- Modify `@keyframes terminal-view-fade-in` in `src/components/views/terminal.css` to animate pure `opacity` from 0 to 1 without `transform: scale(...)`.
- This ensures that character cell measurements (`charSizeService`) and container bounding rects are exact 1:1 pixel measurements from the first frame.

### S2. Synchronous Pre-Spawn Container Geometry Measurement
- In `startSession` within `src/components/views/TerminalView.tsx`, probe `containerRef.current` and invoke `fitAddon.fit()` synchronously before dispatching `start_terminal`.
- If the container already has layout dimensions (`clientWidth > 0`), use the exact measured `term.cols` and `term.rows` instead of defaulting to 80×24.
- Update `lastColsRef.current` and `lastRowsRef.current` immediately so ConPTY is spawned with the true pane geometry from byte zero.

### S3. Low-Latency Geometry Synchronization (Adaptive Debounce)
- In `fitTerminal`, dispatch resize to ConPTY immediately (or within a 20ms frame) during the initial layout stabilization phase rather than waiting 100ms.
- Retain debounced updates for continuous mouse-drag splitter adjustments, but ensure the initial geometry sync happens before the CLI outputs its welcome banner.

### S4. Buffer-Aware Scroll Restoration
- Check `term.buffer.active.type` in `restoreScroll()`:
  - When `term.buffer.active.type === 'alternate'` (e.g., OpenCode, vim, nano, htop), skip `scrollToBottom()`/`scrollToLine()` and instead call `term.refresh(0, term.rows - 1)` to clear any dirty renderer cells.
  - When in `'normal'` buffer, preserve standard scroll position without triggering redundant delayed timers.

### S5. Explicit Redraw / Refresh Mechanism
- Add `kite:terminal-command` action `refresh` / `redraw`:
  - Triggers `fitTerminal(true)`, `term.refresh(0, term.rows - 1)`, and sends `resize_terminal` to ConPTY to force a full redraw on demand.
- In `terminal-canvas-area`, on click / focus, when in the alternate buffer, call `term.refresh(0, term.rows - 1)` to wipe away any transient visual glitches.

---

## 3. Files Modified

| File | Change Scope |
| :--- | :--- |
| `src/components/views/terminal.css` | Replaced `transform: scale(0.995)` with pure opacity fade-in to prevent character sizing distortion. |
| `src/components/views/TerminalView.tsx` | Added pre-spawn geometry probe, adaptive 20ms resize dispatch, buffer-aware scroll restoration, and explicit redraw handler. |
| `odd/tasks/terminal-ghosting-and-redraw-fix.md` | Dedicated architecture and restoration record. |

---

## 4. Verification & Testing

1. **TypeScript compilation**:
   ```bash
   npx tsc --noEmit
   ```
2. **Terminal unit tests**:
   ```bash
   npx vitest run src/lib/terminalLinkNav.test.ts src/lib/terminalRegistry.test.ts
   ```
3. **Reference Sanitizer Audit**:
   ```bash
   node .kite/sanitizer/audit-references.mjs --check
   ```
4. **Visual Behavior Check**:
   - Open an agent pane with OpenCode in a narrow or split view.
   - Confirm that the banner and shortcuts table wrap cleanly according to the real pane width.
   - Confirm that when tools or sub-processes execute, previous headers do not remain pinned or overlaid.
   - Confirm that clicking into the terminal or triggering a refresh leaves zero visual artifacts.

---

## 5. Rollback / Restoration Guide

If for any reason this fix needs to be inspected, isolated, or reverted independently:
1. All changes are strictly confined to `src/components/views/terminal.css` and `src/components/views/TerminalView.tsx`.
2. To revert this fix using git:
   ```bash
   git checkout origin/feat/ui-composer -- src/components/views/terminal.css src/components/views/TerminalView.tsx
   ```
   Or revert the specific commit titled `fix(terminal): eliminate ghost text and synchronize ConPTY geometry`.
