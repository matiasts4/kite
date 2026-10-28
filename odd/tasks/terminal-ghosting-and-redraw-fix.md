# Terminal Ghosting and Redraw — Attempt Log

Status: E1 implemented, waiting for a visual check. No Rust change.
Branch: `feat/ui-composer`.
Rule: one hypothesis per commit. Do not mix this work with unrelated dirty files.

Visual checks the user cares about:

1. A new Grok or OpenCode terminal must open coherent in a narrow pane, including when three terminals share one view.
2. OpenCode must stay coherent over minutes. Ghost lines, stuck headers, and character collisions must not accumulate.

---

## Symptom log

### S-launch — scrambled first frame (regression, confirmed 2026-10-28)

Opening Grok or OpenCode in a tight pane paints a broken welcome screen. Text from the same TUI frame overlaps, clips, and lands in the wrong columns. Example: the Grok welcome menu (`Resume session`, `Changelog`, `Quit`, `New worktree`) is torn apart, and the footer `Grok 4.` is cut off.

User report after the geometry commit:

- Three terminals in one view open this way for both Grok and OpenCode.
- A later resize plus real use can heal Grok.
- The same gesture does not heal OpenCode.

This is a first-paint geometry failure. The TUI addressed cells for one size. The visible grid was another size. Relative cursor moves then stack fragments on top of each other.

### S-ghost — artifacts over time (original bug, still open)

Before the launch regression, OpenCode sessions accumulated ghosting during normal use:

- A previous table or header stayed pinned over newer output.
- In-place updates collided (`Notfrbidden` style merges).
- A manual resize, or leaving the view and coming back, cleared the ghosts because that path refits and the app repaints.

Grok tends to redraw a full frame, so it self-heals. OpenCode updates damaged cells only, so a bad frame sticks.

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

1. **Unstable size at spawn (S-launch).** The PTY is opened on a transient grid. The TUI paints with cursor addressing. A later shrink wraps those addresses and the lines overlap. Grok heals because a real resize plus input redraws the whole screen. OpenCode does not, because it only patches cells.
2. **Resize storms during the first second (S-launch and S-ghost).** Four delayed fits plus a 20ms debounce deliver several SIGWINCHs while the banner is still being written. A delta TUI cannot reconstruct from a partial ConPTY redraw.
3. **`refresh()` paints the damaged buffer (S-ghost sticks).** It clears renderer dirt. It does not clear logical ghosts left by a soft-wrap plus cursor-up (`CSI A` / `CSI 2K`) when the app and xterm disagreed on width.
4. **Soft-wrap ghosts after the grid is wrong even once (S-ghost).** If OpenCode believes a row is one line and xterm wrapped it, cursor-up erases only the tail. The head stays forever. This matches the original "resize clears it" report.
5. **Width disagreement on symbols (only if 1–4 are fixed and `Notfrbidden` remains).** UTF-8 versus the console code page, or emoji width, shifts later in-place writes. Not the first experiment.

A minimum pane width would hide narrow layouts. It would not make a 40-column terminal a correct 40-column terminal. Do not use it as the fix.

---

## Next experiments (not started)

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

How to check, without mixing other branch work:

1. Stay on `feat/ui-composer`. This attempt does not need a Rust rebuild or a Vite cache wipe.
2. Close the current dev window. `npm run app` stops the previous debug process and opens a new one against the Vite server on port 1420.
3. Open **new** Grok and OpenCode terminals after that launch. Sessions that were already painting before the restart can keep a torn frame in the PTY.
4. Put three terminals in one view. The welcome screen should be readable before any manual resize. "Starting ConPTY session..." may show for a fraction of a second while the pane settles. That wait is this attempt.
5. If the frame is still torn on a brand-new terminal, E1 failed. Do not continue to E2 on that result.

### E2 — One settled resize, no local repaint fight

Only if E1 is clean and OpenCode still ghosts over minutes.

- Keep xterm in ConPTY mode so it does not reflow on its own.
- After the last size change settles, send one `resize_terminal`.
- Do not refresh the canvas in the middle of a polled chunk.
- Confirm a full app redraw happens once. If OpenCode ignores a same-size resize, change the size by a real row or column, not by refreshing xterm.

Pass: a long OpenCode session no longer keeps stuck headers, and a resize is not required to read the screen.

### E3 — Encoding, only if characters still collide

Only if the grid is stable and in-place updates still merge glyphs.

- Set UTF-8 for the spawned console (`chcp 65001` inside that PTY, not the parent shell).
- Set `TERM=xterm-256color`.
- Re-check one emoji or box-drawing update. Do not bundle this with E1.

---

## Verification when an experiment lands

- `npx tsc --noEmit`
- `npx vitest run src/lib/terminalLinkNav.test.ts src/lib/terminalRegistry.test.ts`
- `node .kite/sanitizer/audit-references.mjs --check`
- Manual: three agent terminals in one view, Grok and OpenCode, no manual resize.
- Manual: use OpenCode for several minutes and confirm old rows do not remain pinned.

## Rollback

Attempt 1 is exactly `986e308`. Revert that commit to return to the pre-geometry behavior. Later experiments must say which commit to revert.
