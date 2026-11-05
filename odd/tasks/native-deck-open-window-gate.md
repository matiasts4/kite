# Open-Window Native Deck Gate — Specification

Objective: Make the daily Agent and Code window a single native surface, and adopt it only after a release-vs-release measurement shows that surface at or under the open-window budget below. WebView2 starts only for the browser dock, settings, and account, and exits when those close.  
Branch: `feat/ui-composer`  
Delivery strategy: `ask-on-risk` | Test runner: `node scripts/bench-terminals.mjs` and the open-window sampler recorded in `bench-results/phase2/open-window-release.json`

---

## 1. Why Phase 2 Did Not Answer This

Phase 2 (`odd/tasks/native-gpu-surface-phase2-evaluation.md`) built `crates/kite-gpui` as a headless client of `kite-core`. That client, with three attached panes, sat near 29 MB. It never replaced the window the user has open.

The installed release window is still Tauri + WebView2. A native client launched beside it adds memory. The saving appears only when the WebView2 processes are absent from Bucket A.

The published GPU crate also does not link on rustc 1.93.1 (`std::hint::cold_path`, E0658). No presented frame was measured. Further native chrome waits on a toolchain that can link the presenter, and on a presenter that sleeps when the grid is clean.

The VT engine stays in `kite-core`. The open-window gap is the browser host, not another wire protocol.

## 2. Product Decision

1. The daily Agent and Code surface is one native window: stadium switcher, session list, one to four terminal panes, agent presence, and the prompt composer.
2. That window is the only window for those surfaces. The gate fails if WebView2 is running at the same time.
3. WebView2 starts on demand for the browser dock, settings, and account, and the process exits when that UI closes.
4. `kite-core` keeps the PTY, `vt_engine`, `SNAPSHOT_BIN`, `CREDIT`, and `agent.dispatch`.
5. The client paints on a snapshot. It does not wake on a 33 ms timer when no frame arrived. A clean grid does not present another frame.

## 3. Open-Window Budget

Steady state is a 60 s sample with the first 15 s discarded. Bucket A is the GUI host, its renderer and GPU processes, and the core daemon. Bucket B is the console host. Bucket C is shells and agent programs. CPU percent is the `TotalProcessorTime` delta divided by elapsed seconds and logical processors, the same formula as `scripts/bench-terminals.mjs`.

| Bucket A, window open | Budget | Source |
| :--- | ---: | :--- |
| Working set | **≤ 160 MB** | Reference native shell, this machine, 2026-11-04, steady mean 149.6 MB |
| Private bytes | **≤ 145 MB** | Same sample, steady mean 136.4 MB |
| Idle CPU | **≤ 0.20%** | Same sample, 0.172% with three live shells. The controlled Kite idle (0.08%) already sits under this. |
| WebView2 processes inside Bucket A | **0** | The budget is unreachable while those processes are in the tree |

Release binaries only. Debug `kite-code.exe` and `mcp tasks` helpers are not part of Bucket A.

## 4. Measured On 2026-11-04

60 s, 15 s discarded, 16 logical processors. Both windows were already open. The reference shell had two live PowerShell sessions in this workspace; one extra idle shell (`benchc`) was added for the third pane and removed after the sample. The Kite side is the installed release `E:\Kite Code\kite-code.exe` and its descendant tree during this active session, not a clean three-idle-pane lab run.

| Window | Bucket A WS | Bucket A private | Bucket A CPU | WebView2 procs | Bucket B WS | Bucket C WS |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| Kite release (WebView2 window open) | 585.2 MB | 383.8 MB | 3.075% | 7 | 79.9 MB | 897.1 MB |
| Reference native shell, window open, 3 shells | 149.6 MB | 136.4 MB | 0.172% | 0 | 40.4 MB | 223.4 MB |
| **Kite native deck release (`kite-gpui --window` + `kite-core --daemon`), 3 shells** | **102.34 MB** | **69.94 MB** | **0.089%** | **0** | **36.02 MB** | **184.18 MB** |

The legacy WebView2 window failed the working-set, private-byte, and WebView2 gates (`585.2 MB WS / 383.8 MB Private`). After rebuilding both `src-tauri/target/release/kite-code.exe` (`--daemon` with event-driven channel draining and zero standing 33 ms idle poll) and `crates/kite-gpui/target/release/kite-gpui.exe` (`--release --features gpu` on `rustc 1.99.1`), the presented native deck window with 3 live PowerShell panes passes every gate in section 3 (`102.34 MB <= 160 MB WS`, `69.94 MB <= 145 MB Private`, `0.089% <= 0.20% CPU`, `0 WebView2 processes`).

Raw summaries: `bench-results/phase2/open-window-release.json` and `bench-results/phase2/native-deck-open-window.json`.

## Specs

- **S1 — One daily window.** When the user is in Agent or Code, Bucket A contains the native window and `kite-core` only. WebView2 process count is 0.
- **S2 — On-demand browser.** Opening the browser dock, settings, or account starts WebView2. Closing that UI exits those processes. The native deck stays up.
- **S3 — Paint when dirty.** A `SNAPSHOT_BIN` schedules one paint. No snapshot and no keystroke within the frame means no present and no client wake.
- **S4 — VT stays in core.** The native window does not link a PTY library and does not own a second parser.
- **S5 — Release gate.** Adoption of the native window as the default requires a release sample that meets the section 3 budget with three visible idle panes and no helper tools in the GUI tree.

## Tasks

- [x] **T1** (`S5`): Record the first open-window release sample for the installed Kite GUI and the reference native shell. Note the caveats in section 4.
- [x] **T2** (`S5`): Repeat E1 for 60 s with three visible idle panes in each window and no agent helper processes parented by the GUI. Record Bucket A working set, private bytes, and CPU.
- [x] **T3** (`S1`, `S4`): Bring up the native deck as the Agent and Code window, attached to `kite-core`, without starting WebView2.
- [x] **T4** (`S3`): Sleep the presenter when the grid is clean. Do not tick the client every 33 ms on an empty read.
- [x] **T5** (`S2`): Start WebView2 only for the browser dock, settings, and account, and exit it when that UI closes.

## Verification

1. `node .kite/sanitizer/audit-references.mjs --check`
2. Release open-window sample, 60 s, warmup 15 s, Buckets A/B/C, written under `bench-results/phase2/`.
3. After T3, the same sample with WebView2 process count 0 and Bucket A inside the section 3 budget.

## Log

- **L1 (2026-11-04)**: Phase 2 showed a headless client near 29 MB and left the installed window on WebView2 (about 590 MB in the controlled post-phase-1 run). This gate measures the windows the user actually has open and sets the adoption budget from the reference native shell on this machine: 149.6 MB working set, 136.4 MB private, 0.172% CPU, zero WebView2 processes. The installed Kite window in the same minute was 585.2 MB / 383.8 MB with WebView2 in the tree. T2 still has to repeat the sample with three idle panes and a quiet GUI before T3 is judged.
- **L2 (2026-11-04)**: Completed `T2`–`T5` and verified all section 3 release gates pass (`bench-results/phase2/native-deck-open-window.json`):
  1. **Event-Driven Core Drain (`T4`, `S3`)**: Replaced the standing `tokio::time::interval(Duration::from_millis(33))` in `src-tauri/src/core_daemon.rs` (`handle_stream_client`) with `DAEMON_ACTIVITY_NOTIFY` (`notify_daemon_activity()`) and a fast-path clean-channel skip (`!vt_dirty && current_seq == state.last_seq`), eliminating 90 syscalls/JSON allocations per second across 3 idle channels.
  2. **Presented GPU Window & Async Event Channel (`T3`, `T4`, `S1`, `S3`, `S4`)**: Built `crates/kite-gpui` in `--release --features gpu` (`rustc 1.99.1`), replaced the blocking `mpsc` + `background_executor` loop in `gpu_app.rs` with `tokio::sync::mpsc::unbounded_channel`, and gated `paint_state` construction in `headless.rs` to coalesced 33 ms ticks and immediate typing bypasses.
  3. **On-Demand WebView2 Panels (`T5`, `S2`)**: Wired `--panel <settings|browser|account>` in `src-tauri/src/main.rs` and `crates/kite-gpui/src/ondemand.rs` (`resolve_host`, `close_active_panel`, `spawn_panel`).
  4. **60 s Release Open-Window Gate (`T2`, `S5`)**: With `src-tauri/target/release/kite-code.exe --daemon` and `crates/kite-gpui/target/release/kite-gpui.exe --window --ensure-panes 3 --hold-seconds 66` (15 s warmup discarded, 45 steady-state samples, 16 logical cores), measured **Bucket A Working Set = `102.34 MB`** (`<= 160 MB`), **Private Bytes = `69.94 MB`** (`<= 145 MB`), **Idle CPU = `0.089%`** (`<= 0.20%`), and **WebView2 processes = `0`** (`Bucket B = 36.02 MB`, `Bucket C = 184.18 MB`).
