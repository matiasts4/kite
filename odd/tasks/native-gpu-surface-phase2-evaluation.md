# Phase 2: Native GPU Client Surface (`GPUI`) Architecture, Wire Integration, and Tradeoff Evaluation — Specification

Objective: Design, prototype, and empirically evaluate a hardware-accelerated native GPU client surface (`crates/kite-gpui` over Direct3D 11 / Metal) that connects as a pure visual client to the Phase 1 `kite-core` daemon over the 9-byte framed Named Pipe protocol, eliminating the ~565 MB Chromium/WebView2 memory floor while preserving Kite's visual language and agent orchestration workflows.  
Branch: `feat/ui-composer`  
Delivery strategy: `ask-on-risk` | Test runner: `cargo test` & `node --test scripts/bench-terminals.test.mjs`

---

## 1. Empirical Post-Phase-1 Baseline & Exact Problem Scope

Following the completion and live verification of **Phase 0** (`odd/tasks/terminal-runtime-benchmark-harness.md`) and **Phase 1** (`odd/tasks/kite-core-daemon-and-framed-ipc.md`), Kite's runtime profile on Windows x64 with **3 active terminals** was measured on live hardware:

| Runtime State | **Historical Baseline (Pre-Phase 0)** | **Measured Post-Phase 1 (`HEAD`)** | **Phase 2 Target (`kite-gpui` + `kite-core`)** | **Remaining Bottleneck Addressed by Phase 2** |
| :--- | :--- | :--- | :--- | :--- |
| **GUI Open (`E1-idle`, 3 Terminals — Working Set)** | `~876.0 MB` | **`590.1 MB`** (`Bucket A`) + `43.7 MB` (`Bucket B`) | **`115.0 – 155.0 MB`** (`Bucket A`) | Eliminates the 6 `msedgewebview2.exe` processes (`~565 MB WS` / `~290 MB Private`). |
| **GUI Open (`E1-idle`, 3 Terminals — Private Commit)** | `~670.0 MB` | **`301.2 MB`** (`Bucket A`) | **`85.0 – 125.0 MB`** (`Bucket A`) | Eliminates V8 heap, Blink DOM, and Chromium compositor commit. |
| **Headless / Window Closed (`E4-headless`, 3 Live Sessions)** | ❌ Impossible (killed PTYs) | **`24.6 MB WS` / `11.1 MB Private`** (`kite-core --daemon`) | **`24.6 MB WS` / `11.1 MB Private`** (unchanged; owned by `kite-core`) | Already solved in Phase 1 (`+473 KB` Private per terminal inside `kite-core`). |
| **Idle CPU % (`E1-idle`, 3 Terminals)** | `3.50% – 4.50%` | **`0.08%`** (GUI Open) / **`0.00%`** (Headless) | **`0.00%`** | Already solved in Phase 1 (`< 0.2%` target met). |
| **30 Hz Streaming CPU % (`E2-spinners` / `E2-logburst`)** | High (6–80 ms JSON poll) | **`0.15% – 0.17%`** | **`< 0.10%`** | Direct `BinaryCellRecord` $\to$ GPU glyph/quad instance submission without IPC hop to Chromium. |
| **Live Session Reattach Latency (`S4`)** | Respawned shell (`> 800 ms`) | **`0.65 ms`** (`session.attach` over Named Pipe) | **`< 2.0 ms`** (connect + first D3D11 frame) | Already solved in Phase 1; Phase 2 renders the attached `SNAPSHOT_BIN` directly to D3D11. |

### Why Phase 2 Is Strictly Scoped to the View Layer

Because `kite-core` (`src-tauri/src/core_daemon.rs`) already owns PTY creation, `vt_engine` state, `SNAPSHOT_BIN` serialization, `CREDIT` backpressure, session persistence, and `agent.dispatch` over `\\.\pipe\kite-core-v1-<username>`:
1. **Zero Backend Duplication**: `crates/kite-gpui` links **neither** `portable_pty` **nor** a duplicate session supervisor. It is a 100% stateless visual client over the Phase 1 Named Pipe.
2. **Simultaneous Dual-Surface Operation**: Because `kite-core` supports multiple concurrent client connections on `\\.\pipe\kite-core-v1-<username>`, a user or developer can run the Tauri/WebView2 window and the `kite-gpui` native window **at the same time against the exact same live agent terminals**.
3. **Controlled Engineering Investment**: We only keep and expand the native GPUI surface where its measured UX and memory advantages justify the Rust UI maintenance cost.

---

## 2. Crate Layout & Internal Module Architecture (`crates/kite-gpui`)

Phase 2 introduces a standalone Rust binary/library crate under `crates/kite-gpui` (kept decoupled from `src-tauri` so Tauri builds remain untouched):

```text
crates/kite-gpui/
├── Cargo.toml
└── src/
    ├── main.rs            # Application entry, CLI flags (--attach-session, --workspace), window bootstrap
    ├── theme.rs           # AGENTS.md tokens: 4-tier radii (4/6/8/12/14/9999px), 3-tier heights (32/28/38px), palette
    ├── core_client.rs     # Async Named Pipe client: JSON handshake, 9-byte frame mux, Channel 0 RPC, CREDIT loop
    ├── snapshot_bin.rs    # Zero-copy reader for 32-byte SNAPSHOT_BIN header + 16-byte BinaryCellRecord + ExtendedSnapshotMeta
    ├── sprites.rs         # Procedural GPU quads for box-drawing (U+2500..257F), block elements (U+2580..259F), braille
    ├── terminal_view.rs   # GpuiTerminalView, CachedRowOps, 33 ms OUTPUT_CLOCK, <200 ms key bypass, mouse/key encoding
    ├── input_keymap.rs    # VT/xterm key encoding, applicationCursor, bracketedPaste, Win32 input mode (DEC 9001), Kitty flags
    └── shell/
        ├── mod.rs         # Root workspace layout (TitleBar + Sidebar + Split Terminal Grid + Agent Composer)
        ├── title_bar.rs   # Protected stadium mode switcher (Agent | Code | Thread) + resource badge
        ├── sidebar.rs     # Live session list (from session.list / FACTS) + workspace filter (28px compact rows)
        ├── split_grid.rs  # 1..4 pane proportional split container with 12px card radius and concentric 1px border
        └── composer.rs    # Multi-agent prompt composer & prompt-throw dispatch bar (drives Channel 0 agent.dispatch)
```

---

## 3. Wire Protocol & Rendering Pipeline Specification

### 3.1 Named Pipe Connection & Channel Multiplexing (`core_client.rs`)

1. **Discovery & Auto-Spawn**:
   - On startup, `CoreClient::connect()` reads `%APPDATA%\Kite Code\core-session.token` (or `Kite Code Dev\core-session.token`), connects to `KITE_CORE_PIPE` or `\\.\pipe\kite-core-v1-<username>`, and sends the JSON handshake line:
     ```json
     {"protocol":"kite-core/v1","framed":true,"client":"kite-gpui","pid":42000,"authToken":"<token>"}
     ```
   - If the pipe is not listening, `CoreClient::connect()` spawns `kite-code.exe --daemon` with `CREATE_NO_WINDOW | DETACHED_PROCESS` and retries for up to `500 ms`.
2. **Session Discovery & Attachment**:
   - Immediately after the handshake, `CoreClient` sends a Channel `0` `FrameKind::Rpc` (`0x00`) call to `session.list`.
   - For each visible pane in the active workspace, `CoreClient` sends `session.attach`:
     ```json
     {"jsonrpc":"2.0","id":2,"method":"session.attach","params":{"sessionId":"<id>","mode":"snapshot_bin","cols":120,"rows":36,"live":true}}
     ```
   - The daemon binds `channelId >= 1` with an initial credit of **2 snapshot frames** and immediately streams a full `SNAPSHOT_BIN` frame (`kind = 0x02`) on that `channelId`.
3. **Viewport Visibility & Focus Gating (`FrameKind::Focus = 0x05`)**:
   - When a terminal pane is hidden (switched to another workspace/tab or window minimized), `kite-gpui` sends a 2-byte `FOCUS` frame (`[focused = 0, live_visible = 0]`) on `channelId`, instructing `kite-core` to stop emitting snapshots for that channel while keeping the PTY and `vt_engine` running.
   - When the pane becomes visible again, `kite-gpui` sends `[focused, live_visible = 1]`, triggering an immediate full `SNAPSHOT_BIN` frame.

### 3.2 Zero-Allocation Row Cache & `SNAPSHOT_BIN` Ingestion (`snapshot_bin.rs` & `terminal_view.rs`)

Unlike a browser surface that must cross a JS/WASM or IPC boundary, `kite-gpui` reads the 16-byte `BinaryCellRecord` entries directly from the pipe read buffer into GPU-ready row draw lists:

```rust
#[derive(Clone, Debug)]
pub struct BgQuadOp {
    pub start_col: u16,
    pub end_col: u16,
    pub rgba: u32,
}

#[derive(Clone, Debug)]
pub struct GlyphOp {
    pub col: u16,
    pub width: u8,
    pub codepoint: u32,
    pub grapheme_utf8: Option<SharedString>,
    pub fg_rgba: u32,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub dim: bool,
}

#[derive(Clone, Debug)]
pub struct CachedRowOps {
    pub row_seq: u64,
    pub wrapped: bool,
    pub style_epoch: u32,
    pub bg_quads: Arc<[BgQuadOp]>,
    pub glyphs: Arc<[GlyphOp]>,
    pub sprites: Arc<[ProceduralSpriteOp]>,
}
```

- **Dirty-Row Only Reconstruction**:
  - When a `SNAPSHOT_BIN` payload arrives on `channel_id`:
    1. Parse the 32-byte header (`seq`, `cols`, `rows`, `cursor_col`, `cursor_row`, `cursor_flags`, `mode_flags`, `dirty_row_count`, `total_cells`, `overflow_utf8_len`, `exit_code`).
    2. If `full_frame` (`mode_flags & 0x01`) is set and dimensions changed, resize `painted_rows` to `rows`.
    3. Iterate only over the `dirty_row_count` descriptors (`[u16 row_idx][u16 raw_count]`, where `wrapped = (raw_count & 0x8000) != 0` and `count = raw_count & 0x7fff`).
    4. For each dirty row, coalesce contiguous runs of identical `bg_rgba` into `BgQuadOp` spans, route box-drawing/block/braille codepoints (`U+2500..U+259F`, `U+2800..U+28FF`) to `ProceduralSpriteOp` (pixel-snapped rects/lines with zero font-atlas dependency), and shape remaining text codepoints into `GlyphOp` entries.
    5. Store the resulting `CachedRowOps` at `painted_rows[row_idx]` with `row_seq = seq`.
  - All unchanged rows (`rows - dirty_row_count`) retain their existing `Arc<[BgQuadOp]>`, `Arc<[GlyphOp]>`, and `Arc<[ProceduralSpriteOp]>` pointers with **zero CPU work and zero heap allocations**.

### 3.3 Unified 30 Hz `OUTPUT_CLOCK` + `< 200 ms` Input Bypass + `CREDIT` Return

To guarantee `0.00%` idle CPU and `< 1.0%` streaming CPU across 3+ concurrent agent terminals:

1. **Immediate Typing Path (`< 200 ms`)**:
   - Whenever the user presses a key or pastes text in `GpuiTerminalView`, `self.last_typed_at = Some(Instant::now())`, and the encoded VT/Win32-input bytes are sent immediately on `channel_id` via `FrameKind::Data` (`0x01`).
   - If a `SNAPSHOT_BIN` frame arrives while `self.last_typed_at.is_some_and(|t| t.elapsed() < Duration::from_millis(200))`, the view calls `cx.notify()` immediately on the current frame and sends back a 4-byte `FrameKind::Credit` (`amount = 1`) as soon as the frame is painted.
2. **Coalesced Background Streaming Path (`33 ms` / `30 Hz`)**:
   - When `last_typed_at` is older than `200 ms`, incoming `SNAPSHOT_BIN` frames update `painted_rows` in memory and set `self.pending_paint_credit += 1`, registering the view with the window-wide `OUTPUT_CLOCK` (`Duration::from_millis(33)`).
   - When the single 33 ms `OUTPUT_CLOCK` tick fires, all dirty terminal panes in the window repaint in **one combined GPU pass**, and each pane flushes its accumulated `pending_paint_credit` in a single `FrameKind::Credit` frame back to `kite-core`.

---

## 4. Visual Language & Protected Brand Contracts (`AGENTS.md` Compliance)

Every component in `crates/kite-gpui/src/theme.rs` and `src/shell/` MUST enforce the exact geometric constants from `AGENTS.md`:

| Token / Contract | Constant in `theme.rs` | Exact Value | Applied Surfaces in `kite-gpui` |
| :--- | :--- | :--- | :--- |
| **Micro Radius** | `RADIUS_XS` / `RADIUS_SM` | `4.0 px` / `6.0 px` | Keycap hints (`Ctrl+Shift+P`), status chips, PID badges. |
| **Control Radius** | `RADIUS_CONTROL` | `8.0 px` | All buttons, text inputs, select triggers, sidebar session rows. |
| **Card Radius** | `RADIUS_CARD` | `12.0 px` | Terminal split-pane cards, agent status cards, composer container. |
| **Dialog Radius** | `RADIUS_DIALOG` | `14.0 px` | Command palette, quick-switch modal, telemetry popover. |
| **Pill Radius** | `RADIUS_PILL` | `9999.0 px` | TitleBar stadium switcher, agent status dots, toggles. |
| **Optical Nesting** | `inner_radius(outer)` | `(outer - 1.0).max(0.0)` | Concentric `1px` inner border highlight on terminal cards (`11px` inside `12px`) and controls (`7px` inside `8px`). |
| **Control Heights** | `HEIGHT_STD` / `HEIGHT_COMPACT` / `HEIGHT_HERO` | `32.0 px` / `28.0 px` (`26.0 px`) / `38.0 px` | `32px` header actions & search; `28px` sidebar rows & toolbar buttons; `38px` hero prompt bar. |
| **TitleBar Stadium Switcher** | `TitleBarModeSwitcher` | Stadium pill (`Agent \| Code \| Thread`) | Exact geometry, padding, and spring-interpolated sliding active pill indicator. |

---

## 5. Surface-by-Surface Coexistence & Tradeoff Matrix

Because porting 100% of Kite's secondary screens to Rust/GPUI at once is unnecessary to capture 90% of the daily memory and latency wins, Phase 2 defines a clear boundary between **Core Native Surfaces (`Path B: Hybrid Native Deck`)** and **Full Shell Replacement (`Path C`)**:

| Surface / Subsystem | **Milestone** | **Estimated Rust LOC** | **Included in Path B (Hybrid Native Deck)?** | **Included in Path C (Full Native Shell)?** | **Engineering Tradeoff & Rationale** |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **1. `core_client` + `SNAPSHOT_BIN` + `CREDIT` + `GpuiTerminalView`** | `M1` | `~1,800 LOC` | ✅ **Yes** | ✅ **Yes** | **Highest ROI.** Delivers `< 150 MB` WS, `0` DOM/V8 allocations, and `< 5 ms` key-to-photon latency across 1–4 split terminals. |
| **2. TitleBar (`Agent \| Code \| Thread` Stadium) + Session Sidebar + Split Grid** | `M1` | `~1,400 LOC` | ✅ **Yes** | ✅ **Yes** | Provides complete daily terminal & agent workspace navigation without opening WebView2. |
| **3. Agent Draft Composer + Multi-Target Prompt Throw (`agent.dispatch`)** | `M3` | `~1,200 LOC` | ✅ **Yes** | ✅ **Yes** | Enables full autonomous agent orchestration (`open_terminals`, `send`, `run`, `wait`) natively from `kite-gpui`. |
| **4. Resource & Process Telemetry Popover (`Bucket A/B/C` live monitor)** | `M3` | `~600 LOC` | ✅ **Yes** | ✅ **Yes** | Lightweight table/bars fed directly by `system_metrics`. |
| **5. Account Vault, Provider OAuth Flows, & Rich Settings Modals** | `M4` (Optional) | `~6,500+ LOC` | 🔄 **On-Demand WebView2** (spawns only while configuring, closes after) | ✅ **Yes** | Rare configuration flows; keeping them on-demand in Path B saves months of form/OAuth UI code while costing `0 MB` during normal coding. |
| **6. Embedded Web Browser Dock & Rich HTML/DOM Previews** | `M4` (Optional) | `~4,000+ LOC` | 🔄 **On-Demand WebView2 / External Browser Bridge** | ⚠️ **Requires OS WebView Child Window** | A web browser requires a web engine (`WebView2`) by definition; spawning it only when the Browser Dock tab is open is strictly optimal. |

---

## 6. Phased Milestones & Mandatory Decision Gate (`M1` $\to$ `M2` $\to$ `M3`)

### Milestone `M1` — Functional `kite-gpui` Terminal & Session Deck Prototype
1. Create `crates/kite-gpui` with `core_client.rs`, `snapshot_bin.rs`, `sprites.rs`, `terminal_view.rs`, `input_keymap.rs`, `theme.rs`, and `shell/` (`title_bar.rs`, `sidebar.rs`, `split_grid.rs`).
2. Connect to live `kite-core --daemon` over `\\.\pipe\kite-core-v1-<username>`, list active sessions, attach 1–3 split terminal panes in `snapshot_bin` mode, and support full keyboard/mouse/resize/scrollback/clipboard interaction.

### Milestone `M2` — Empirical Benchmark & Retention Gate (Mandatory Stop-and-Evaluate)
Run `scripts/bench-terminals.mjs` across `E1-idle` (1, 2, 3 terminals), `E2-spinners` (3 terminals), and `E2-logburst` (3 terminals) comparing `kite-gpui` against Tauri/WebView2 (`HEAD`):

| Gate Metric | **Post-Phase 1 WebView2 (`HEAD`)** | **Mandatory `M2` Pass Threshold for `kite-gpui`** |
| :--- | :---: | :---: |
| **`Bucket A` Working Set (`E1-idle`, 3 Terminals)** | `590.1 MB` | **`<= 160.0 MB`** ($\ge 3.6\times$ reduction) |
| **`Bucket A` Private Bytes (`E1-idle`, 3 Terminals)** | `301.2 MB` | **`<= 120.0 MB`** ($\ge 2.5\times$ reduction) |
| **`Bucket A` Idle CPU % (`E1-idle`, 3 Terminals)** | `0.08%` | **`0.00%`** |
| **`Bucket A` 30 Hz Streaming CPU % (`E2-spinners`, 3 Terminals)** | `0.17%` | **`<= 0.12%`** |
| **Frame Paint Latency `p99` (`E2-logburst`, 3 Terminals)** | Canvas2D + IPC | **`< 2,000 μs` (`2.0 ms`)** |
| **Visual & Protocol Parity** | Baseline | **Zero** box-drawing gaps, **zero** VS16 width shifts, 100% DEC 2026 / SGR mouse parity |

- **Decision Rule at `M2`**:
  - If `M1` meets all thresholds above, proceed to **`M3` (Path B: Hybrid Native Deck with Agent Composer & Prompt Throw)** as the primary daily surface for `Agent` and `Code` terminal workflows, launching WebView2 only on demand when web-specific panels are requested.

### Milestone `M3` — Native Agent Composer, Prompt Throw, and Telemetry Popover
1. Implement `shell/composer.rs` driving `agent.dispatch` over `kite-core` Channel `0` with target-pane selection and animated prompt-throw feedback.
2. Add Seamless Surface Handoff: a single button/shortcut in the TitleBar swaps between the `kite-gpui` native window and the full WebView2 window in `< 50 ms` by detaching/attaching the same `kite-core` session channels.

---

## Specs

- **S1 — Stateless Client Isolation Over Phase 1 `kite-core` Pipe**:
  - `WHEN` `kite-gpui` runs `THEN` it MUST communicate exclusively with `kite-core` over `\\.\pipe\kite-core-v1-<username>` using the 9-byte framed protocol (`session.list`, `session.create`, `session.attach`, `session.detach`, `SNAPSHOT_BIN`, `DATA`, `CREDIT`, `RESIZE`, `FOCUS`, `agent.dispatch`) without linking `portable_pty` or owning child PTY handles in the UI process.
- **S2 — Zero-Allocation Dirty-Row Cache & Procedural Box/Block Sprites**:
  - `WHEN` a `SNAPSHOT_BIN` frame arrives on an attached channel `THEN` `GpuiTerminalView` MUST rebuild `CachedRowOps` (`BgQuadOp`, `GlyphOp`, `ProceduralSpriteOp`) only for rows present in `dirty_row_count`, reusing existing `Arc` slices for all clean rows and rendering `U+2500..U+259F` / `U+2800..U+28FF` via pixel-snapped procedural quads.
- **S3 — Unified 33 ms `OUTPUT_CLOCK`, `< 200 ms` Typing Bypass, and `CREDIT` Flow Control**:
  - `WHEN` background output streams across 1–4 visible panes `THEN` `kite-gpui` MUST coalesce redraws onto a single `33 ms` (`30 Hz`) window tick and return `FrameKind::Credit` (`0x03`) only after GPU frame submission; `WHEN` the user types within `200 ms` `THEN` the view MUST bypass the 33 ms hold and notify on the immediate v-sync.
- **S4 — Full Input & Terminal Mode Parity (`SGR Mouse`, `Bracketed Paste`, `Application Cursor`, `Win32 Input Mode`)**:
  - `WHEN` `SNAPSHOT_BIN` updates `mode_flags` or `ExtendedSnapshotMeta` (`applicationCursor`, `bracketedPaste`, `mouseMode`, `sgrMouse`, `sgrPixelsMouse`, `focusReporting`, `win32InputMode`, `kittyKeyboardFlags`, `title`, `clipboardWrite`) `THEN` `input_keymap.rs` and `terminal_view.rs` MUST route keyboard, mouse wheel/click/drag, focus events, and OSC 52 clipboard writes with 100% parity against the existing canvas surface.
- **S5 — Simultaneous Dual-Surface Coexistence & `< 50 ms` Surface Handoff**:
  - `WHEN` both the Tauri WebView2 window and `kite-gpui` attach to the same `sessionId` in `kite-core` (or hand off via detach/attach) `THEN` both surfaces MUST render identical grids, cursor states, and titles without dropping PTY bytes, starving `CREDIT`, or restarting the underlying agent process.
- **S6 — Strict `AGENTS.md` Visual Token & Protected Zone Compliance**:
  - `WHEN` `kite-gpui` renders any shell chrome, pane card, button, input, or the TitleBar mode switcher `THEN` it MUST use the exact 4-tier radius tokens (`4/6px`, `8px`, `12px`, `14px`, `9999px` with `outer - 1px` concentric inner borders), 3-tier control heights (`32px`, `28px/26px`, `38px`), and stadium `Agent | Code | Thread` switcher geometry.

## Tasks

- [ ] **T1** (`S1` | route: delegated/inline): Create `crates/kite-gpui/src/core_client.rs` and `src/snapshot_bin.rs` implementing the async Named Pipe client (`\\.\pipe\kite-core-v1-<username>`), JSON handshake, Channel 0 JSON-RPC client (`session.list`, `session.create`, `session.attach`, `session.detach`, `agent.dispatch`), 9-byte frame demuxer, and zero-copy `SNAPSHOT_BIN` parser with unit tests over `tokio::io::duplex`.
- [ ] **T2** (`S2`, `S3` | route: delegated/inline): Implement `crates/kite-gpui/src/sprites.rs` and `src/terminal_view.rs` (`GpuiTerminalView`, `CachedRowOps`, `BgQuadOp` run-length coalescing, procedural box-drawing/block/braille sprites, 33 ms `OUTPUT_CLOCK`, `< 200 ms` typing bypass, and post-paint `CREDIT` replenishment).
- [ ] **T3** (`S4` | route: delegated/inline): Implement `crates/kite-gpui/src/input_keymap.rs` covering standard VT keys, `applicationCursor`, `bracketedPaste`, SGR mouse (`1000/1002/1003/1006/1016`), `focusReporting` (`1004`), `win32InputMode` (`9001`), and `kittyKeyboardFlags` with unit test parity against `TerminalCanvasSurface`.
- [ ] **T4** (`S5`, `S6` | route: delegated/inline): Implement `crates/kite-gpui/src/theme.rs` and `src/shell/` (`title_bar.rs` with the protected stadium switcher, `sidebar.rs` with 28px session rows, and `split_grid.rs` with 1–4 panes and 12px/11px concentric card borders).
- [ ] **T5** (`S1`–`S6` | route: inline): **Milestone `M2` Gate** — Run `scripts/bench-terminals.mjs` (`E1-idle`, `E2-spinners`, `E2-logburst`) against `kite-gpui` + `kite-core`, verify `Bucket A` Working Set `<= 160 MB` and Private Bytes `<= 120 MB` with 3 active terminals, and record the empirical comparison in `## Log`.
- [ ] **T6** (`S1`, `S5`, `S6` | route: delegated/inline): **Milestone `M3`** — Implement `crates/kite-gpui/src/shell/composer.rs` (multi-agent prompt dispatch driving Channel 0 `agent.dispatch`) and TitleBar surface handoff between `kite-gpui` and Tauri WebView2.

## Verification

1. `cargo test --manifest-path crates/kite-gpui/Cargo.toml`
2. `cargo test --manifest-path src-tauri/Cargo.toml core_daemon`
3. `node scripts/bench-terminals.mjs --scenario E1-idle --terminals 3 --seconds 60`
4. `node scripts/bench-terminals.mjs --scenario E2-spinners --terminals 3 --seconds 60`
5. `node .kite/sanitizer/audit-references.mjs --check`

## Log

- **L1 (2026-11-03)**: User requested a detailed, specific ODD specification for Phase 2 (Native GPU surface / GPUI migration and tradeoff evaluation), emphasizing that Phase 2 is under active evaluation to be tested after Phase 1 Core so the team can weigh its code complexity against real consumption gains and decide how much of the native surface to retain.
- **L2 (2026-11-03)**: Enhanced Phase 2 ODD specification with empirical post-Phase-1 hardware baselines (`590.1 MB WS / 301.2 MB Private` GUI open vs `24.6 MB WS / 11.1 MB Private` headless `kite-core`), complete `crates/kite-gpui` module architecture (`core_client.rs`, `snapshot_bin.rs`, `sprites.rs`, `terminal_view.rs`, `input_keymap.rs`, `theme.rs`, `shell/`), `CachedRowOps` + procedural sprite pipeline, `SGR/DEC 9001/Kitty` input parity (`S4`), surface-by-surface LOC & coexistence matrix (`Path B` Hybrid Native Deck vs `Path C` Full Native Shell), and 6 granular implementation tasks (`T1`–`T6`).
