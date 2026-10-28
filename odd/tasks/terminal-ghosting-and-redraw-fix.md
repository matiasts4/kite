# Terminal Ghosting and Redraw — Attempt Log

Status: not a general terminal failure. See `odd/tasks/terminal-session-artifact.md`. One saved OpenCode session reproduces the artifacts in every pane where that session is opened. Other sessions on this branch stay clean. The experiments below were scored while that session was the sample, so they are not a verdict on the rest of the terminal.
Branch: `feat/ui-composer` at `2053249`.
Rule: do not reopen that session to judge a new terminal change. If a later pass debugs the session itself, keep one hypothesis per commit.

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

## Verification when an experiment lands

- `npx tsc --noEmit`
- `npx vitest run src/lib/terminalLinkNav.test.ts src/lib/terminalRegistry.test.ts`
- `node .kite/sanitizer/audit-references.mjs --check`
- Manual: three agent terminals in one view, Grok and OpenCode, no manual resize.
- Manual: use OpenCode for several minutes and confirm old rows do not remain pinned.

## Rollback

Attempt 1 is exactly `986e308`. Revert that commit to return to the pre-geometry behavior. E1's stable-host wait is `5ffdb58`. The blank-pane follow-up is `41c1d60`. Revert `41c1d60` to restore the early 80×24 spawn. E2 is `7d649d8`. Revert it to restore local alt-screen refresh. E3 is the commit that sets `lineHeight` to `1`. Revert it to restore `1.16`. Later experiments must say which commit to revert.
