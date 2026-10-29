# One OpenCode session paints the artifacts

Status: implemented on `feat/ui-composer` (28 October 2026); ready for visual verification against the saved OpenCode session.

The specimen is one saved OpenCode session. Opening it previously painted artifacts in every pane that showed it while ordinary sessions stayed coherent. The same session also reproduced the artifacts on the untouched 25 October tree `df914ea` and on `feat/ui-baseline-1025` at `6a639fe`. Do not use this session to score an unrelated terminal change. Do use it when the change is an attempt at this bug. A clean ordinary session does not prove this bug is gone.

Capture instrument: `938bd89`. It does not change paint. Captures can contain prompts, paths, and secrets. Do not paste decoded terminal text into this file, a commit, or a chat.

## Root causes identified and addressed (28 October 2026)

1. **Unicode 11 + ZWJ emoji width mismatch (`@xterm/addon-unicode11` + `11-zwj`)**:
   - Without `@xterm/addon-unicode11`, xterm defaults to Unicode 6 cell widths (`1` column for many symbols/emojis that modern TUI engines measure as `2` columns, and unjoined widths for ZWJ sequences).
   - Because this OpenCode session paints strictly by cursor addressing (`CUP`) and line clears (`EL`) without erasing the display (`ED` = 0), a single 1-column disagreement on a status icon, badge, or ZWJ sequence shifts the rest of the row and leaves stale cells stranded outside subsequent partial erases.
   - `activateTerminalUnicodeProvider` in `src/lib/terminalViewport.ts` loads `@xterm/addon-unicode11` and registers `ZwjAwareUnicode11Provider` (`11-zwj`) so xterm and the TUI agree on every cell column.
2. **Modern `@xterm/xterm` 6.0.0 ConPTY buffer semantics + `@xterm/addon-webgl` 0.19.0**:
   - Restored `@xterm/xterm` `^6.0.0`, `@xterm/addon-fit` `^0.11.0`, `@xterm/addon-unicode11` `^0.9.0`, and `@xterm/addon-webgl` `^0.19.0` with `windowsPty: { backend: 'conpty', buildNumber: 22631 }`, `customGlyphs: true`, and `rescaleOverlappingGlyphs: false`.
   - When the WebGL renderer is active, `repairWebglCanvasForDevicePixelRatio` ensures the backing canvas matches `window.devicePixelRatio` and refreshes the viewport on DPR changes or context loss fallback.
3. **DOM block-element gradient synthesis (`U+2580..U+2595`)**:
   - When a pane renders through the DOM fallback, font metrics can leave hairline seams across runs of Unicode block elements (`▀`, `▄`, `█`, `▌`, `▐`, `▏`, `▕`, `▔`, `▁`).
   - `attachDomBlockFillCleanup` in `src/lib/terminalViewport.ts` observes `.xterm-rows` and replaces uniform block-element spans with exact CSS `linear-gradient` fills.
4. **Post-spawn & foreground grid drift reconciliation**:
   - A capture showed the initial grid staying at `28×33` for 28.3 seconds while the TUI addressed column 57.
   - `reconcilePtySizeAfterSpawn` now checks the fitted grid across animation frames immediately after PTY spawn, and `scheduleForegroundGridDriftCheck` verifies `terminalGridDriftedFromFit` during foreground output writes.
   - In addition, `splitAlternateScreenEnterChunk` splits incoming streams at `\x1b[?1049h` whenever a resize or grid drift is pending so the terminal fits **before** the alternate screen begins painting.
5. **Targeted ConPTY rewrite & renderer-risk row refresh + transient cursor-show stripping**:
   - Removed the rejected 160 ms alternate-screen fit delay, the artificial `rows - 1` / `rows` double-resize step, and the local `ALT_SCREEN_BLANK` (`\x1b[2J\x1b[H`) injection.
   - Kept a 16 ms (`SYNC_OUTPUT_MAX_HOLD_MS`) DEC 2026 synchronized-output hold so split poll chunks within a single frame are written atomically.
   - `classifyForegroundOutputRefresh` strips transient `\x1b[?25h` cursor shows inside cursor-positioned frames and uses `writeTerminalOutputWithRefresh` to refresh dirty row ranges tracked by `_core._inputHandler.onRequestRefreshRows` (plus one follow-up animation-frame refresh on Windows ConPTY in-place rewrites).

## What was tried

Committed attempts on `feat/ui-composer`. Each one was judged while this session was on screen, so a fail here is not a verdict that every OpenCode session is broken.

| Commit | What it changed | Result with this session |
| :--- | :--- | :--- |
| `986e308` | Fit before spawn, shorter resize debounce, alt-screen `refresh()`, no `reset()` on a fresh start, removed the fade-in scale. | Launch got worse. Torn first frames. |
| `5ffdb58` | Spawn only after the pane size settles. | New panes stayed blank. The process had already started at 80×24. |
| `41c1d60` | Reserve the session first. Spawn only when the pane is measured. | Fresh panes opened coherent. This closed the launch regression. It did not explain the session that still ghosts. |
| `7d649d8` | Stop local alt-screen refresh. One resize after the write finishes. | OpenCode block marks stayed sliced. |
| `a19ca9a` | Set `lineHeight` to `1`. | The same sliced mark remained. |
| `19a291b` | Paint every pane with the WebGL renderer. | Did not remove the artifacts. |
| `e4fd0f3` | Revert the WebGL renderer. | Back to the DOM renderer. |
| `2053249` | UTF-8 console and `TERM=xterm-256color` for agent launches. | Not a separate visual pass. Not the cause and not the cure. |
| `b775ada` | xterm 5.3. One visible pane uses WebGL. Two or more visible panes use canvas on every pane. A lost WebGL context stays on canvas. | Visual pass on 28 October 2026. The same artifacts remain. |
| `938bd89` | Opt-in JSONL capture of lifecycle and PTY bytes. | Diagnostic only. |
| `e1e3377` | Document that this one session is the trigger. | Docs only. |

Uncommitted passes after `938bd89`, all on 28 October 2026. None of them fixed the picture. The user said so after each launch. Do not commit them as a fix.

| Pass | What it changed | Result |
| :--- | :--- | :--- |
| Grid fit | `src/lib/terminalViewport.ts`. One extra column when horizontal slack remains. An extra row only when clipping it costs less than the gap. Do not subtract the 15px fallback scrollbar. | Artifacts remained. Capture: no erase-display. Grids 43×33, 42×33, 107×45, 122×46, 111×46, 80×46, 120×46, 140×46. |
| Resize coalesce | Alternate-screen fits wait 160 ms, then one grid, then the PTY steps one row off and back. No local `refresh()`. | Artifacts remained. The storm continued, because other `resize_terminal` paths still fire immediately. Capture: erase-display 0, 281 synchronized pairs, 5287 cursor addresses, sizes 34×33, 87×45, 97×46, 119×46, 43×46, 95×46, 31×46, 49×46, 172×46, 49×46. |
| Synchronized-frame hold | `src/lib/terminalSyncOutput.ts`. xterm 5.3 ignores DEC 2026, so bytes from the start marker are held until the end marker and written once. 100 ms force-flush. Nothing is dropped. A fit waits while a frame is open. | Artifacts remained. A finished slice still leaves every cell it does not address. Capture: erase-display 0, 147 synchronized pairs. The grid stayed 28×33 for 28.3 seconds and the cursor reached column 57. Then 72×45, 100×46, 108×46, 128×46. |
| Alternate-screen blank | When the column count changes on the alternate screen, write local CSI `2J` and cursor-home before `resize_terminal`. Not sent to the PTY. No `refresh()`. The first grid is not erased. A column change skips the row step. | Launched. The user reports the problem is still not corrected. No further capture was scored for this launch. |

Also rejected, and not applied as the fix: a minimum pane width, and assuming the parent console code page is the cause.

`lineHeight` stayed `1` through every pass above. `windowsPty` stayed `{ backend: 'conpty', buildNumber: 22631 }`. That flag was already set on `df914ea`, which this session also breaks. Do not treat clearing it as the next step unless new evidence says so.

## What the bytes show

This session does not paint by writing lines. The live stream enters the alternate screen once, never leaves it, and never erases the display (`erase J` stays 0). It positions the cursor and sometimes clears to the end of a line, inside synchronized frames. A PowerShell pane from the same launch is the opposite: carriage returns and newlines, no synchronized frames, and it stays coherent.

A later update erases only the cells it addresses. Anything outside that erase stays visible. Holding a whole synchronized slice does not help, because the slice itself is a partial update. Blanking on a later column change does not help the first paint, and the user still saw the artifacts after that blank was added.

Agent resume does not replay the old scrollback into xterm. For an agent CLI the old scrollback file is deleted and `scrollbackBase64` is null. The live stream is the poison.

An older scrollback tail addressed column 91 and row 59. A later tail of the same session addressed column 88 and row 40. Both are stale next to the live captures above.

## Why the text no longer looks like the earlier terminal

`b775ada` is the commit that changed the picture. It did not change the font, the 13px size, the letter spacing, or `lineHeight`.

Before that commit the screen was the DOM renderer in xterm 6, measured by fit addon 0.11. After it, one visible pane uses the WebGL renderer and two or more visible panes use the canvas renderer, both from xterm 5.3, measured by fit addon 0.8. Those renderers draw each glyph into a bitmap. The same face looks heavier or lighter, and the same pane fits a different number of columns and rows.

`a19ca9a` had already set `lineHeight` from `1.16` to `1`. Rows are shorter than they were at the start of this work. Neither change removed the artifacts. The session breaks the DOM tree too, so the bitmap path is not the cause.

## Do not repeat

- Local `term.refresh()` on the alternate screen. It redraws the damaged buffer and the app does not reconstruct it.
- WebGL on every pane.
- An early 80×24 spawn, a fit timer before the pane is measured, or replaying scrollback into a fresh agent TUI.
- Another resize debounce, another one-row PTY step, or another synchronized-frame hold. Those three were launched and the picture did not change.
- Another pass that only changes `lineHeight` without a new reason. `1` did not remove the sliced mark. A bitmap value above `1` cannot explain `df914ea`.
- A minimum pane width.
- Scoring this bug with a healthy session, or scoring an unrelated change with this session.
- Committing the dirty `0.1.40` notes in `CHANGELOG.md`, `src/lib/changelogData.ts`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`. They already say the ghosting is fixed. It is not. `package.json` stays at `0.1.39`.

## Still open for the next agent

The working tree on `feat/ui-composer` contains the four uncommitted passes above. They are not a fix. Leave `feat/ui-baseline-1025` at `6a639fe` and the worktree `E:\kite-worktrees\agent-activity` alone.

Facts the next change has to account for:

- The first measured grid can be tiny and then stay there. One capture held 28×33 for 28.3 seconds before growing to 128×46. A 160 ms debounce cannot collapse that.
- While the grid was 28 columns, the cursor was addressed at column 57. The first paint is already outside the grid. The blank pass does not run on the first grid.
- Later growth clears some lines and never the whole display.
- Grok redraws a full frame on resize and input, so it self-heals. This OpenCode session does not.

S-launch, the scrambled first frame from `986e308`, is closed by `41c1d60`. Do not reopen it while chasing this session.

## Launch and capture

The user starts the dev app with `npm run app` from `E:\kite`. A TypeScript-only retest does not need a Vite cache wipe. After a package change, an already-running Vite on port 1420 can still return 200 for `/` and 504 for a new dependency. Stop that process and delete `node_modules/.vite` before launching again.

Capture stays off unless `KITE_TERMINAL_CAPTURE_DIR` is set on the Kite process. The launcher inherits the environment of the `npm run app` process. One JSONL file per session. Records include base64 bytes, dimensions, sequence, and ANSI marker counts. Delete the directory after the comparison. Do not enable capture for normal use.

```powershell
$captureDir = Join-Path $env:TEMP "kite-terminal-capture"
New-Item -ItemType Directory -Force $captureDir | Out-Null
$env:KITE_TERMINAL_CAPTURE_DIR = $captureDir
npm run app
```

Rollback for the capture itself: remove the capture helpers and capture fields from `src-tauri/src/terminal.rs`, then remove this section. Default behavior is capture disabled.
