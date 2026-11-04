# Phase 1: Detached Core Daemon (`kite-core`), Framed Binary IPC, and Persistent Agent Sessions — Specification

Objective: Decouple terminal lifecycle, VT state, and autonomous agent orchestration from the desktop GUI window into a lightweight persistent background daemon (`kite-core`) communicating over a 9-byte framed binary protocol with credit-based flow control and packed binary grid snapshots.  
Branch: `feat/ui-composer`  
Delivery strategy: `ask-on-risk` | Test runner: `cargo test` (in `src-tauri`) & `npx vitest run`

---

## 1. Problem Statement & Architectural Motivation

Kite currently executes all PTY management (`src-tauri/src/terminal.rs`), VT grid emulation (`src-tauri/src/vt_engine.rs`), session metadata persistence (`src-tauri/src/session_resolver.rs`), and loopback agent dispatch (`src-tauri/src/dispatch_wire.rs`, `src-tauri/src/agent_inbox.rs`) inside the single Tauri GUI host process.

This monolithic coupling creates three structural bottlenecks for multi-terminal and autonomous agent workflows (`Agents` and `Draft` modes):

1. **Fatal Lifecycle Coupling (Window Close Kills Active Agents)**:
   - In `src-tauri/src/main.rs:288` and `main.rs:615-627`, closing the desktop window invokes `snapshot_and_shutdown_all_terminals` (`terminal.rs:2717`), terminating all running PTYs and active AI agents.
   - Reopening Kite reads `terminal-sessions.json` (`session_resolver.rs:40-42`) and **re-spawns** new processes rather than reattaching to live ones. Users cannot close the ~500 MB WebView2 window while leaving autonomous agents working in the background.
2. **JSON + Base64 Data-Plane Serialization Overhead**:
   - Even with the 33 ms output clock (`outputClock.ts:2`) and hidden-pane suspension (`set_terminal_presentation`), `poll_terminal_snapshot_sync` (`terminal.rs:2420-2467`) serializes dirty cells as nested JSON objects alongside `observedBytesBase64`.
   - When 2–3 agent terminals stream concurrently at 30 Hz, JSON stringification in Rust and `JSON.parse` + `atob()` in V8 allocate thousands of short-lived heap objects per second.
3. **No Multiplexed Transport or Explicit Flow Control (`CREDIT`)**:
   - Terminal I/O, grid snapshots, resize events, and agent dispatch commands travel over separate request/response paths without per-channel byte credit accounting. If a heavy UI turn delays consumption, backpressure is not propagated deterministically to the producer channel.
4. **No Headless / Multi-Client Foundation for Phase 2 Surfaces**:
   - Any future lightweight or native GPU client surface (Phase 2) requires a clean, UI-agnostic session daemon so that terminal state and agent orchestration are never reimplemented in the view layer.

---

## 2. Target Architecture (`kite-core` + Client Surface)

```text
┌───────────────────────────────────────────────────────────────────────────┐
│                   kite-core (Persistent Background Daemon)                │
│  Memory Target: ~20–35 MB Private Bytes (0 WebView / 0 GUI Dependencies)  │
│                                                                           │
│  ┌────────────────────┐  ┌────────────────────┐  ┌─────────────────────┐  │
│  │  PTY Supervisor    │  │  VT Grid Engine    │  │  Agent Orchestrator │  │
│  │ (ConPTY / Shells / │─▶│ (Per-Session Grid, │  │ (dispatch_wire,     │  │
│  │  Agent Processes)  │  │  Dirty Row Seq,    │  │  agent_inbox,       │  │
│  │                    │  │  Scrollback Ring)  │  │  session_resolver)  │  │
│  └────────────────────┘  └────────────────────┘  └─────────────────────┘  │
└─────────────────────────────────────┬─────────────────────────────────────┘
                                      │
          Named Pipe: \\.\pipe\kite-core-v1-<user> (Windows)
          Unix Socket: $XDG_RUNTIME_DIR/kite-core-v1.sock (Unix)
          9-Byte Framed Wire Protocol: [u32 channel][u8 kind][u32 len]
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
┌───────────────────┐       ┌───────────────────┐       ┌───────────────────┐
│ Kite Desktop GUI  │       │   kite-agent CLI  │       │  Phase 2 Client   │
│ (Tauri + WebView2 │       │ (Headless Control │       │ (Optional Native  │
│  Binary Canvas)   │       │  & Agent Scripts) │       │  GPU Surface)     │
└───────────────────┘       └───────────────────┘       └───────────────────┘
```

### Core Architectural Decision: Where Does the VT Parser Live?

In `kite-core`, the **VT parser (`vt_engine.rs`) and scrollback ring live inside the daemon**, alongside the PTY reader thread:
- **Why**:
  1. The current WebView2 Canvas2D renderer consumes parsed cell diffs (`dirtyRows`), not raw ANSI byte streams. Keeping `vt_engine` in `kite-core` avoids running a second VT parser in JavaScript or duplicating `vt_engine` in the Tauri shell.
  2. When a GUI window closes and reopens hours later, `kite-core` immediately transmits a single packed binary full-grid snapshot (`SNAPSHOT_BIN` with `full = true`) in `< 5 ms` without replaying megabytes of historical ANSI output through a fresh parser.
  3. For raw-byte consumers (such as the classic DOM fallback or a future Phase 2 native client that prefers raw PTY bytes), `kite-core` also supports raw `DATA` streaming on the same channel.

---

## 3. Wire Protocol Specification (9-Byte Framed Multiplexing)

All communication between any client (Tauri Host, CLI, or Phase 2 UI) and `kite-core` runs over a single bidirectional local stream (Named Pipe on Windows: `\\.\pipe\kite-core-v1-<username>`).

### 3.1 Handshake

Upon connection, the client sends a single UTF-8 JSON line terminated by `\n`:
```json
{"protocol":"kite-core/v1","framed":true,"client":"kite-desktop","pid":12345,"authToken":"<token>"}
```
`kite-core` validates `authToken` (stored with user-only ACL in `%APPDATA%\Kite\core-session.token`) and replies with a single UTF-8 JSON line:
```json
{"protocol":"kite-core/v1","framed":true,"coreVersion":"0.1.0","corePid":6789,"activeSessions":3}
```
Immediately after the `\n` of the handshake reply, both directions switch strictly to **9-byte binary frames**.

### 3.2 9-Byte Frame Header Layout (Little-Endian)

Every frame begins with an exact 9-byte header:

```text
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        channel_id (u32 LE)                    |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|   kind (u8)   |              payload_len (u32 LE)             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|          payload_len (cont.)                  |  payload ...  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

- `channel_id: u32`:
  - `0`: **Control Channel** (JSON-RPC 2.0 requests, responses, and lifecycle notifications).
  - `1..=u32::MAX`: **Terminal Session Channels** (assigned when a client calls `session.create` or `session.attach`).
- `kind: u8`:
  - `0x00` — `RPC` (Valid only on `channel_id == 0`; UTF-8 JSON-RPC 2.0 payload).
  - `0x01` — `DATA` (Client $\to$ Core: raw PTY stdin bytes; Core $\to$ Client: raw PTY stdout bytes when attached in `raw` mode).
  - `0x02` — `SNAPSHOT_BIN` (Core $\to$ Client: packed binary VT grid diff or full frame).
  - `0x03` — `CREDIT` (Bidirectional 4-byte `u32 LE` payload granting additional byte/frame budget on `channel_id`).
  - `0x04` — `RESIZE` (Client $\to$ Core: 8-byte payload `[u16 cols][u16 rows][u16 pixel_width][u16 pixel_height]`).
  - `0x05` — `FOCUS` (Client $\to$ Core: 2-byte payload `[u8 focused][u8 live_visible]`).
  - `0x06` — `CLOSE` (Bidirectional channel teardown / process exit status `[u8 exited][i32 exit_code]`).
  - `0x07` — `FACTS` (Core $\to$ Client: lightweight metadata update JSON: `{ cwd, title, activeEngine, providerSessionId, agentState }`).
- `payload_len: u32`: Byte length of payload following the 9-byte header (capped at `16 MiB` maximum frame size; oversized frames abort the connection).

### 3.3 Explicit Flow Control (`CREDIT` Frames)

To prevent a fast PTY producer (e.g., `cargo build` or 3 streaming agents) from overwhelming the client or buffering unbounded memory in IPC queues:
1. When a client attaches to `channel_id >= 1` via `session.attach`, it starts with an initial receive window of **256 KiB** (or **2 snapshot frames** in `snapshot_bin` mode).
2. Each `DATA` or `SNAPSHOT_BIN` frame sent by `kite-core` deducts from that channel's available credit on the daemon.
3. While a channel's credit is exhausted (`available_credit == 0`), `kite-core` continues feeding the PTY output into its in-memory `vt_engine` at full speed, coalescing dirty rows without emitting wire frames on that channel.
4. As soon as the client finishes painting a frame (`requestAnimationFrame` / Canvas2D flush), it sends a 9+4 byte `CREDIT` frame (`kind = 0x03`), immediately re-arming `kite-core` to emit the next coalesced 33 ms snapshot.

---

## 4. Packed Binary Grid Snapshot Format (`SNAPSHOT_BIN`, `kind = 0x02`)

Replaces JSON serialization in `poll_terminal_snapshot_sync` (`src-tauri/src/terminal.rs:2420-2467`) and fulfills Phase 4 of `odd/tasks/runtime-idle-cost.md`.

### 4.1 32-Byte Snapshot Header (Little-Endian)

| Offset | Type | Field | Description |
| :--- | :--- | :--- | :--- |
| `0..8` | `u64` | `seq` | Monotonic VT grid sequence number. |
| `8..10` | `u16` | `cols` | Grid width in cells. |
| `10..12` | `u16` | `rows` | Grid height in cells. |
| `12..14` | `u16` | `cursor_col` | 0-based cursor column. |
| `14..16` | `u16` | `cursor_row` | 0-based cursor row. |
| `16` | `u8` | `cursor_flags` | Bit 0: `visible`, Bit 1: `blink`, Bits 2..4: `shape` (`0=block, 1=underline, 2=bar`). |
| `17` | `u8` | `mode_flags` | Bit 0: `full_frame`, Bit 1: `alt_screen`, Bit 2: `mouse_reporting`, Bit 3: `bracketed_paste`, Bit 4: `sync_output`, Bit 5: `exited`. |
| `18..20` | `u16` | `dirty_row_count` | Number of dirty row descriptors following the header. |
| `20..24` | `u32` | `total_cells` | Total `BinaryCellRecord` structs in the cell table. |
| `24..28` | `u32` | `overflow_utf8_len` | Byte length of the trailing UTF-8 string table (for multi-codepoint grapheme clusters). |
| `28..32` | `i32` | `exit_code` | Process exit code (valid when `mode_flags` Bit 5 is set; otherwise `0`). |

### 4.2 Dirty Row Index Table (`4 bytes * dirty_row_count`)

Each dirty row entry is 4 bytes:
- `row_index: u16` (0-based visible row index)
- `cell_count: u16` (number of cells for this row, normally `cols`)

### 4.3 Packed Cell Record (`16 bytes * total_cells`)

```rust
#[repr(C, packed)]
pub struct BinaryCellRecord {
    /// Unicode scalar value if Bit 7 of `attrs` is 0.
    /// If Bit 7 of `attrs` is 1 (multi-codepoint grapheme), holds `(offset: u24, len: u8)` into `overflow_utf8`.
    pub codepoint_or_span: u32,
    /// Packed RGBA foreground color (`0xRRGGBBAA`). Alpha=0 means default foreground.
    pub fg_rgba: u32,
    /// Packed RGBA background color (`0xRRGGBBAA`). Alpha=0 means default background.
    pub bg_rgba: u32,
    /// Cell display width (`0` = wide-char continuation spacer, `1` = narrow, `2` = wide).
    pub width: u8,
    /// Attribute bitmask: Bit 0=bold, 1=dim, 2=italic, 3=underline, 4=inverse, 5=strikethrough, 6=invisible, 7=grapheme_span.
    pub attrs: u8,
    /// Reserved / underline style & color index.
    pub extra: u16,
}
```

On the frontend (`src/components/views/terminal/canvas/`), the renderer wraps the `ArrayBuffer` in a `DataView` / `Uint32Array` and paints dirty rows directly into the 2D context without allocating per-cell JS objects.

---

## 5. Control Channel (`channel_id == 0`) JSON-RPC 2.0 Contract

| Method | Params | Result | Behavior |
| :--- | :--- | :--- | :--- |
| `session.create` | `{ sessionId, workspaceId?, paneId?, engine, cwd, cols, rows, env? }` | `{ sessionId, channelId, rootPid, spawnedAtUnixMs }` | Spawns PTY in `kite-core`, initializes `vt_engine`, persists entry in `terminal-sessions.json`, and binds `channelId`. |
| `session.attach` | `{ sessionId, mode: 'snapshot_bin' \| 'raw', cols, rows, live: boolean }` | `{ sessionId, channelId, rootPid, exited, exitCode, facts }` | Binds session to `channelId` for this client connection and immediately queues one `SNAPSHOT_BIN` (`full = true`) frame. |
| `session.detach` | `{ sessionId }` | `{ detached: true }` | Unsubscribes client connection from `sessionId` **without** killing the PTY or clearing `vt_engine`. |
| `session.list` | `{ workspaceId? }` | `{ sessions: LiveSessionSummary[] }` | Lists all live and exited sessions currently managed by `kite-core`. |
| `session.terminate` | `{ sessionId, owner }` | `{ terminated: true, exitCode }` | Explicitly kills the PTY process tree and removes the session from `kite-core`. |
| `agent.dispatch` | `DispatchEnvelope` (existing `dispatch_wire.rs` schema) | `DispatchResult` | Routes autonomous agent actions (`open_terminals`, `send_prompt`, `close_terminals`, `await_idle`) directly inside `kite-core` even if no GUI window is open. |
| `core.shutdown` | `{ force: boolean }` | `{ shuttingDown: true }` | Explicitly terminates all PTYs and stops `kite-core` (invoked only on explicit "Quit Kite & Stop Background Sessions" user action). |

---

## 6. Window Close Survival & Session Lifecycle Rules

| User / System Event | Old Behavior (`HEAD`) | New Phase 1 Behavior (`kite-core`) |
| :--- | :--- | :--- |
| **Close Main Window (`X` button / `Alt+F4`)** | Calls `snapshot_and_shutdown_all_terminals()`, killing all PTYs and active agents. | Sends `session.detach` for all mounted channels and closes the WebView2 + Tauri GUI process. `kite-core` and all active PTYs/agents keep running in the background (~25–35 MB RAM). |
| **Reopen Kite Desktop App** | Reads `terminal-sessions.json`, spawns brand-new shells/agents, replays raw scrollback file. | Connects to running `kite-core`, calls `session.list` + `session.attach`, and paints the live VT grid in `< 10 ms` with zero process restart. |
| **Explicit "Terminate Pane" (`releaseTerminal`)** | Calls `terminate_terminal` IPC. | Sends `session.terminate` over Channel 0, killing that specific PTY tree and removing it from `terminal-sessions.json`. |
| **Explicit "Quit Application & Stop All Agents" (Tray / Menu Action)** | Same as window close. | Sends `core.shutdown({ force: true })` to `kite-core`, cleanly snapshotting scrollback and terminating all child PTY trees before exiting. |
| **GUI Crash / Renderer Hang** | Takes down or orphans child PTYs. | `kite-core` detects pipe EOF, marks client channels detached, and keeps all agent processes and builds running untouched. |

---

## Specs

- **S1 — Binary Snapshot Encoding & Zero-Object Canvas Decoding (`Phase 1A`)**:
  - `WHEN` a visible terminal pane receives a `SNAPSHOT_BIN` frame `THEN` the binary payload MUST decode into the exact same grid cells, wide-character continuations, cursor state, modes, and sequence numbers as the legacy JSON `RenderSnapshot`, while allocating zero per-cell objects on the V8 heap.
- **S2 — 9-Byte Multiplexed Wire Framing & `CREDIT` Backpressure (`Phase 1A/1B`)**:
  - `WHEN` 2 or 3 terminal channels stream continuous output `THEN` `kite-core` MUST frame every message with `[u32 channel_id][u8 kind][u32 payload_len]`, pause snapshot emission on any channel whose `CREDIT` balance reaches `0`, continue updating `vt_engine` in-memory, and emit a single coalesced delta frame immediately upon receiving a `CREDIT` replenishment frame.
- **S3 — Out-of-Process `kite-core` Daemon Discovery & Auto-Spawn (`Phase 1B`)**:
  - `WHEN` the Kite desktop app or `kite-agent` CLI starts `THEN` it MUST attempt to connect to `\\.\pipe\kite-core-v1-<username>` (validating `core-session.token`); if no live daemon responds, it MUST spawn `kite-core` in background daemon mode and complete the JSON-line handshake within `500 ms`.
- **S4 — Window-Close Survival & Instant Live Reattach (`Phase 1B`)**:
  - `WHEN` the user closes the main Kite GUI window while terminals or autonomous agents are running `THEN` the GUI process MUST exit without killing the PTYs in `kite-core`, reducing platform memory to the headless daemon footprint (`< 40 MB` Private Bytes); `WHEN` the user reopens the GUI window `THEN` it MUST reattach to all live sessions in `kite-core` and render their current grids without restarting the underlying processes.
- **S5 — Daemon-Owned Agent Dispatch & Loopback Continuity (`Phase 1B`)**:
  - `WHEN` an external agent script or `kite-agent.mjs` dispatches a command while the main GUI window is closed `THEN` `kite-core` MUST execute the dispatch against the live PTY sessions, record state updates in `agent_inbox`, and emit updated `FACTS` / `SNAPSHOT_BIN` frames when a GUI client next attaches.

## Tasks

- [x] **T1** (`S1` | route: inline/delegated): Implement `BinaryCellRecord` and 32-byte `SNAPSHOT_BIN` serializer in `src-tauri/src/vt_engine.rs` + TypeScript `DataView` decoder in `src/components/views/terminal/canvas/binarySnapshotDecoder.ts` with parity unit tests against JSON `RenderSnapshot`.
- [x] **T2** (`S2` | route: inline/delegated): Implement the 9-byte framed codec (`[u32 channel][u8 kind][u32 len]`) and per-channel `CREDIT` flow-control state machine in `src-tauri/src/core_wire.rs`.
- [x] **T3** (`S3`, `S4` | route: inline/delegated): Extract PTY registry, `vt_engine`, and `session_resolver` runtime host into `src-tauri/src/core_daemon.rs` listening on `\\.\pipe\kite-core-v1-<username>`, and update `src-tauri/src/main.rs` so window close detaches instead of shutting down live terminals.
- [x] **T4** (`S4`, `S5` | route: inline/delegated): Move `dispatch_wire.rs` and `agent_inbox.rs` ownership into `kite-core` and wire Tauri frontend `useTerminalSession.ts` / `useTerminalSnapshotPoller.ts` to `session.attach` + `CREDIT` replenishment.

## Verification

1. `cd src-tauri && cargo test`
2. `npx tsc --noEmit`
3. `npx vitest run`
4. Run benchmark scenarios `E1`–`E4` from `odd/tasks/terminal-runtime-benchmark-harness.md` and verify `E4` (Headless window close + reopen with 2 active agents) preserves child PIDs and stays under `40 MB` Private Bytes while headless.
5. `node .kite/sanitizer/audit-references.mjs --check`

## Log

- **L1 (2026-11-03)**: User authorized writing detailed, specific ODD documentation for Phase 1 (Core communication, binary framing, credit flow control, and out-of-process terminal/agent persistence independent of the desktop window).
- **L2 (2026-11-03)**: Initial Phase 1 implementation drafted across `vt_engine.rs`, `core_wire.rs`, `core_daemon.rs`, `main.rs`, `binarySnapshotDecoder.ts`, and `useTerminalSnapshotPoller.ts`.
- **L3 (2026-11-03)**: Audited Phase 1 implementation against `S1`–`S5`, identified 11 critical/high defects, and remediated all of them:
  1. **Out-of-Process Daemon Spawn & Pipe RPC Client (`S3`, `S5`)**: Added `probe_core_daemon_pipe` and `send_core_daemon_rpc` in `src-tauri/src/core_daemon.rs`; `ensure_core_daemon_started()` now probes `\\.\pipe\kite-core-v1-<username>` and spawns `current_exe() --daemon` with `CREATE_NO_WINDOW | DETACHED_PROCESS` (waiting up to `500 ms` for handshake readiness) instead of only spawning an in-process thread. `run_core_daemon_main()` also starts `dispatch_wire::start_background()` and uses `DAEMON_SHUTDOWN_NOTIFY` (`tokio::sync::Notify`) so `core.shutdown` immediately exits the accept loop.
  2. **Window Close Survival (`S4`)**: Updated `src-tauri/src/window.rs` (`app_window_close`) to invoke `core_daemon::on_client_window_close()` (which calls `flush_all_terminal_scrollbacks()` without killing PTYs) instead of `snapshot_and_shutdown_all_terminals("app_window_close")`.
  3. **Full `SNAPSHOT_BIN` Metadata Parity (`S1`)**: Added `MODE_FLAG_APPLICATION_CURSOR` (`0x40`), `MODE_FLAG_EXTENDED_META` (`0x80`), and trailing UTF-8 JSON `ExtendedSnapshotMeta` (`title`, `clipboardWrite`, `mouseMode`, `sgrMouse`, `sgrPixelsMouse`, `focusReporting`, `win32InputMode`, `kittyKeyboardFlags`, `scrollbackOffset`, `scrollbackDepth`, `benchmarkActive`) in both `src-tauri/src/vt_engine.rs` and `src/components/views/terminal/canvas/binarySnapshotDecoder.ts`.
  4. **Zero-Per-Cell-Object Allocation in Steady-State Canvas Polling (`S1`)**: Added `decodeBinarySnapshotIntoGrid` in `binarySnapshotDecoder.ts` and `commitDirtyRows` in `snapshotApply.ts` to mutate existing `CellSnapshot` slots in place on steady-state frames, and enabled `preferBinarySnapshot = true` by default in `useTerminalSnapshotPoller.ts` with seamless fallback to `poll_terminal_snapshot` for legacy test mocks.
  5. **Drain Side-Effects & Credit Backpressure (`S1`, `S2`)**: Implemented `poll_terminal_snapshot_bin_bytes` in `src-tauri/src/terminal.rs` (preserving PTY reply flushing, DEC 2026 timeout logging, and output capture), wired `SESSION_CREDIT_TRACKERS` in `core_daemon.rs` so `replenish_terminal_credit` grants real credit and triggers `notify_session_credit_restored` for immediate coalesced delta wakeups, fixed `state.last_seq` updates on the pipe loop so subsequent frames emit dirty-row deltas, and added `RawData`, `FACTS`, and `CLOSE` frame emission.
  6. **True `rootPid` & Idempotent `session.terminate` (`S3`, `S4`)**: Stored `root_pid` on `TerminalInstance` at PTY spawn, returned real `rootPid` and `spawnedAtUnixMs` across `session.create`, `session.attach`, and `session.list`, and made `session.terminate` report `terminated: false` when a session does not exist.
  - **Verification**: `cargo test` passed across `vt_engine` (11 passed), `core_wire` (5 passed), `core_daemon` (7 passed), and `system_metrics` (12 passed); `npx vitest run` passed across `binarySnapshotDecoder.test.ts` (23 passed) and `TerminalCanvasSurface` suites (13 passed); `npx tsc --noEmit` clean; `audit-references.mjs --check` (`[CLEAN]`).
- **L4 (2026-11-03)**: Independent verification (`gentle-ai-verify`) surfaced 4 blocker groups across `S1`–`S5`; applied the bounded correction batch and verified all 4 resolved on recheck:
  1. **S1 (`packedGridRef` seeding & `observedBytesBase64` bridge)**: Fixed `useTerminalSnapshotPoller.ts` to seed `packedGridRef.current` on frame 1 and reuse it on subsequent frames without running `commitDirtyRows` twice; added `RowSnapshot.wrapped` (bit 15), `CursorSnapshot.blink` (bit 1), and `ExtendedSnapshotMeta.observedBytesBase64` / `observedText` so `recordTerminalOutput` receives observed PTY text on the binary snapshot path; added regression suites `useTerminalSnapshotPoller.gridReuse.test.ts` and `binarySnapshotSpec.test.ts` (31/31 tests passing).
  2. **S2 (§3.2 oversized frame connection abort)**: Updated `handle_stream_client` in `src-tauri/src/core_daemon.rs` to abort and close the client stream on any `decoder.next_frame()` error (`oversized_frame_aborts_the_client_connection` passing).
  3. **S3 (`kite-agent.mjs` & `dispatch_wire.rs` Named Pipe transport)**: Added `sendCorePipeDispatch` in `scripts/kite-agent.mjs` (`7/7` tests passing in `scripts/kite-agent.test.mjs`) and `dispatch_over_core_pipe` in `src-tauri/src/dispatch_wire.rs` (`45/45` tests passing) speaking the JSON handshake + 9-byte framed Channel 0 `agent.dispatch` RPC over `\\.\pipe\kite-core-v1-<username>`.
  4. **S4 & S5 (GUI-to-daemon RPC proxy, window-close `session.detach`, `DestinationGone`, and `agent_inbox` recording)**: Wired `terminal.rs` (`should_proxy_to_core_daemon`) to proxy `start`, `attach`, `write`, `resize`, `poll_snapshot`, `poll_snapshot_bin`, and `terminate` to `kite-core` when `is_external_daemon_owner()` is true; updated `on_client_window_close` to send `session.detach { all: true }`; updated `LivePort::submit` to return `Err(DispatchError::DestinationGone)` when the target terminal is missing; and recorded `agent_inbox` state entries on daemon `agent.dispatch` (`10/10` `core_daemon` tests and `12/12` `vt_engine` tests passing).
- **L5 (2026-11-03)**: Executed live end-to-end runtime verification against the running detached daemon (`kite-code.exe --daemon`, `PID 19452`) on `\\.\pipe\kite-core-v1-PC`:
  - **`S3` Live Handshake**: JSON-line handshake completed in **`4.96 ms`** (`< 500 ms` budget); full Channel 0 `core.status` RPC round-trip in **`7.42 ms`**. Added `KITE_CORE_PIPE` environment variable support in `get_core_pipe_name()` for isolated daemon testing.
  - **`S1`/`S3` Live Multi-Terminal Spawn**: Created 3 live `powershell.exe` PTY sessions (`eval-live-1`, `eval-live-2`, `eval-live-3`) over Channel 0; verified real OS `rootPid`s (`16164`, `8436`, `12328`) and distinct `channelId`s (`2, 3, 4`). Daemon memory increased from `22.99 MB WS / 9.77 MB Private` (0 terminals) to **`24.17 MB WS / 11.19 MB Private`** with 3 active terminals (~`473 KB` Private Bytes per terminal in `kite-core`).
  - **`S4` Live Window-Close Detach & Reattach**: Executed `session.detach { all: true }`; verified **3/3 (`100%`)** child `rootPid`s remained alive in Windows while headless at **`24.58 MB WS / 11.25 MB Private Bytes`** (`< 40 MB` Private Bytes target). Subsequent `session.attach` completed in **`0.65 ms`** (`< 10 ms` target).
