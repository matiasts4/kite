# Runtime Idle Cost — Terminal Output Clock, Hidden Panes, and Local Update Feed

Status: Phases 1, 2, 3, 4, and 5 are implemented on feat/ui-composer (Phase 4 landed via `SNAPSHOT_BIN` in `d6bd4c1`).

This specification plans the work. It does not authorize a branch switch, a commit, or a UI-toolkit change. Implement it on the branch already checked out. Other agents are editing that branch; touch only the files each phase names.

## 1. Problem

An idle Kite window keeps spending CPU on terminal paint, and a dev session can keep a separate Node process alive only to serve the local update feed.

The canvas terminal asks Rust for a grid snapshot on a timer:

- 60 ms while the terminal is focused and nothing changed
- 80 ms while it is unfocused and nothing changed
- 6 ms after a snapshot arrives
- 16 ms while the alternate screen is active
- 500 ms while `document.hidden` is true and the last answer was unchanged

Each tick is a Tauri command, `poll_terminal_snapshot`, which serializes a JSON diff. A pane that is mounted but not the one the user is looking at still runs this timer. The classic renderer has a second timer, the parked poller in `terminalSessionRegistry.ts`, which calls `read_terminal_output` every 80–400 ms for sessions that are not mounted.

The PTY reader thread already feeds the VT engine and writes parser replies. Paint polling is not what keeps the session alive. It is what keeps the UI and the IPC path awake. Two jobs are still tied to that paint tick and must move before the timer can stop: output capture (the poll takes `inst.buffer`) and provider-session bind attempts. Exit detection also runs inside the poll.

The local updater endpoint is `http://127.0.0.1:9101/studio/latest.json`. When that port is closed, `ensure_local_feed_if_needed` in `src-tauri/src/updater.rs` spawns `node scripts/feed-server.mjs`. That process serves `feed/` and stays up after the check.

## 2. Product outcome

- A visible terminal that is not receiving output and not being typed in does not issue snapshot or byte-poll commands.
- A burst of output paints at most 30 times per second. A key the user just pressed paints on the next frame, within 16 ms of the key.
- A terminal that is not on screen keeps its PTY and its parsed grid. It does not serialize or paint until it is shown again, and the first paint after that is one complete frame.
- Closing a pane, hiding it, or minimizing the window does not kill the session. Closing the main window still ends sessions, as it does today.
- Checking for updates against the loopback feed does not spawn `node.exe`.
- Cursor blink, selection, resize, and the existing VT snapshot contract keep working.

## 3. Non-goals

- A new UI toolkit, a native GPU scene graph, or a rewrite of the React shell.
- A background daemon that outlives the main window.
- Replacing the system ConPTY host, or bundling another console host.
- A new terminal renderer, a new VT parser, or any change to DEC 2026 synchronized output, resize policy, alternate-screen seed, or the 80-column floor.
- Changing the WebView2 background-throttling flags. Those stay as they are.
- Serving the public release feed. This work only replaces the loopback server the app itself starts.

## 4. Current contracts that stay

These stay the source of truth until Phase 4, and Phase 4 must produce the same logical values.

`poll_terminal_snapshot` returns either:

- `{ kind: "unchanged", seq, exited, exitCode }`
- `{ kind: "snapshot", snapshot, exited, exitCode }`

`snapshot` is the existing `RenderSnapshot`: sequence, size, modes, cursor, `dirtyRows`, `full`, title, clipboard write.

`read_terminal_output` stays the byte path for the classic renderer.

`set_canvas_active` today is a side effect: `poll_terminal_snapshot` forces it on, `read_terminal_output` forces it off. That coupling goes away. Presentation becomes an explicit input. See Phase 2.

The reader thread in `src-tauri/src/terminal.rs` keeps feeding the VT engine and flushing parser replies as soon as bytes arrive. Phases must not move that work onto the UI timer.

## 5. Phases

Ship in this order. Do not start a phase until the previous phase's checks pass. Phase 4 waits on a measurement, not only on the earlier phases. The feed phase does not touch the terminal and may land beside Phase 1.

### Phase 1 — Output clock

**Intent.** Replace the always-on poll with a wake plus a clock.

**Backend**

- After the reader thread feeds bytes that change the grid, the title, the cursor, or the exit state, emit one lightweight Tauri event, `terminal://activity`, with `{ sessionId, seq }`. Do not put cells in the event.
- Coalesce emits on the Rust side to at most one activity event per session per 16 ms while output is continuous. A transition from idle to active still emits immediately.
- Move output capture onto the reader thread, next to the existing scrollback flush. `poll_terminal_snapshot` must not be the only consumer of `inst.buffer`.
- Move provider-session bind attempts off the paint command. Keep the current gaps (1.2 s, 3.5 s, 8 s, 18 s, four attempts). A slow Rust timer or the reader thread may own them.
- Detect process exit on the reader thread's end, or on `try_wait` from that same slow path, and emit `terminal://activity` with the exited flag. The UI must learn about exit without a paint timer.
- `poll_terminal_snapshot` remains the way to pull a diff. It does not schedule the next pull.

**Frontend**

- Delete the standing `setTimeout(poll, 6..80)` loop in `useTerminalSnapshotPoller`.
- Subscribe to `terminal://activity` for the mounted session.
- On activity, pull one snapshot. While further activity arrives, pull at most every 33 ms.
- If the last answer is `unchanged` and no newer activity event is waiting, stop. Do not schedule another pull.
- A key, paste, or mouse report that the surface sends arms an immediate pull, in the same turn, and also keeps the 33 ms cap from applying to that one pull.
- Cursor blink runs on the canvas clock from the cursor's `blink` flag. It must not require a snapshot poll.
- The parked poller follows the same rule: no standing timer. On `terminal://activity` for an unmounted classic session, call `read_terminal_output` at most every 33 ms. Canvas mode continues to stop parked pollers, as `syncParkedPollers` does today.

**Acceptance**

- With one focused canvas terminal at a shell prompt and no typing, a 10 s trace shows no `poll_terminal_snapshot` call.
- While a command streams, snapshot pulls are at least 33 ms apart, except the single immediate pull after a key.
- A key at an idle prompt produces a snapshot pull within 16 ms.
- An exiting process still calls `onProcessExit` with no paint timer running.
- Output capture still records bytes when the pane is idle for more than one poll interval.
- Existing `vt_engine` snapshot tests and `TerminalCanvasSurface` tests pass. Add a pure test for the clock: idle stays stopped, a burst collapses to the 33 ms gap, a key bypasses the gap once.

### Phase 2 — Suspend panes that are not visible

**Intent.** A live session that the user cannot see does not serialize a grid.

**Contract**

Add `set_terminal_presentation`:

```ts
{ sessionId: string; live: boolean }
```

- `live: true` means this surface is the one that should receive paint wakes and snapshot diffs.
- `live: false` means keep the PTY, keep parsing, keep capture and scrollback, and do not emit `terminal://activity` for paint. Exit and bind behavior from Phase 1 still run.
- Calling `poll_terminal_snapshot` or `read_terminal_output` must not flip this flag as a side effect.

**When `live` is false**

- The pane is not the visible terminal in the layout, including a background tab or a pane scrolled out of the split.
- `document.visibilityState` is `hidden`, or the window is minimized.

**When the surface becomes live again**

- Set `live: true`.
- Pull one snapshot with a full grid (`full: true`), then resume the Phase 1 clock.
- Do not replay the raw byte tail into a second parser.

**Acceptance**

- Two canvas panes, only one visible: the hidden pane produces no snapshot commands until it is shown.
- Showing it paints the current grid in one full snapshot, including output that arrived while it was hidden.
- Minimizing the window stops snapshot pulls. Restoring it paints one full frame, then the clock resumes.
- A hidden agent session keeps running. Its PTY is still alive and its next visible frame matches the VT grid.
- Classic parked sessions that fail the live test do not run the parked timer.

### Phase 3 — Paint only dirty rows

**Intent.** `renderCanvasGrid` walks every visible row twice on every frame. A frame whose diff touched one row still repaints the whole grid.

**Behavior**

- The renderer records the row indexes in `dirtyRows` and paints background and text only for those rows, plus the old and new cursor cells when the cursor moves.
- A full paint still happens when `snapshot.full` is set, on resize, on font or theme change, on a scrollback jump, and on the resume frame from Phase 2.
- Unchanged rows keep the pixels from the previous frame. Do not clear the whole canvas on a partial frame.
- Selection and link hover may repaint the rows they cover. They must not force a full-grid paint.

**Acceptance**

- A snapshot with one dirty row issues fill and text draws only for that row and any cursor cell that moved. Cover this with a test that records draw calls, or with a counter the renderer already can expose to a test.
- A full snapshot still draws every visible row.
- No change to cell metrics, font stack, line height, or the procedural sprite path.

### Phase 4 — Binary grid frames, only if a profile asks for it

Do not start this phase until Phases 1–3 are in a release build and a CPU profile of a streaming terminal still shows JSON parse or V8 allocation as a top cost. If it does not, close this phase as not needed.

**Behavior**

- Add a pull that returns the same `RenderSnapshot` fields as a little-endian `ArrayBuffer`: a fixed header, then one record per dirty cell.
- Each cell record holds codepoint, width, foreground, background, and the existing attribute bits. No per-cell JSON objects on this path.
- The canvas builds its row arrays from that buffer.
- Keep the JSON command until the binary path matches the JSON path on the existing snapshot fixtures, including alternate screen, title, clipboard write, and exit.

**Acceptance**

- For the same VT byte string, JSON and binary diffs produce equal grids, cursor, modes, and sequence numbers.
- A streaming binary pull still respects the 33 ms clock and the suspended-pane rule.

### Phase 5 — In-process local update feed

Independent of the terminal phases. May land in parallel with Phase 1.

**Behavior**

- The Tauri process serves `http://127.0.0.1:9101` when the updater endpoint is that loopback address.
- Routes stay: `GET /health` returns `ok`; `GET` and `HEAD` serve files under the repo `feed/` directory; `OPTIONS` returns 204. The studio manifest stays at `/studio/latest.json`.
- Bind only `127.0.0.1`. Reject any path that escapes `feed/`. Unknown paths return 404. Responses use `Cache-Control: no-store` and the current content types for `.json`, `.exe`, and `.sig`.
- If something is already listening and `/health` succeeds, do not spawn a second server and do not spawn Node.
- Delete the `node` spawn in `ensure_local_feed_if_needed`.
- `npm run feed` may remain for a person publishing a release while the app is closed. The running app must not call it.

**Acceptance**

- With the app running and nothing else on port 9101, an update check can read `feed/studio/latest.json` and the process list has no `node.exe` started by Kite.
- A path such as `/studio/../../secret` returns 404 and does not read outside `feed/`.
- If an external server already answers `/health`, Kite does not open a second listener.

## 6. Files in play

Phase 1 and 2:

- `src-tauri/src/terminal.rs`
- `src-tauri/src/vt_engine.rs` only for presentation state, not for parsing
- `src/components/views/terminal/canvas/useTerminalSnapshotPoller.ts`
- `src/components/views/terminal/terminalSessionRegistry.ts`
- The pane host that knows which terminal is visible, so it can call `set_terminal_presentation`

Phase 3:

- `src/components/views/terminal/canvas/canvasGridRenderer.ts`
- `src/components/views/terminal/canvas/terminalCanvasTypes.ts` only if the dirty-row set needs a field the snapshot does not already have

Phase 4:

- The snapshot command and the canvas applier. No parser changes.

Phase 5:

- `src-tauri/src/updater.rs`
- A small Rust module for the loopback file server
- `scripts/feed-server.mjs` stays as the manual release tool unless a later change removes it on purpose

## 7. Verification

For every phase, before any commit:

- `npx tsc --noEmit`
- `npx vitest run` for the terminal suites touched, then the full run if those pass
- `node .kite/sanitizer/audit-references.mjs --check`

Manual, on a release build once Phases 1–3 and 5 are in:

- Idle shell: no periodic snapshot commands for 10 s.
- Streaming command: paints no faster than 30 Hz, and typed input still appears immediately.
- Hidden pane and minimized window: no snapshot traffic, then one full frame on return.
- Update check against `127.0.0.1:9101` with no Kite-spawned `node.exe`.

## 8. Risks

- Stopping the poll before capture, bind, and exit move off that command will drop session binding and exit notices. Phase 1 does those moves in the same change as the clock.
- A suspended pane that still forces `canvas_active` through the old poll side effect will keep serializing. Phase 2 removes that side effect.
- Partial canvas paints can leave stale pixels if a full frame is skipped after resize or resume. Phase 3 keeps an explicit full-paint list.
- Phase 4 on top of an open terminal-artifact investigation will mix two causes. Leave it gated.
