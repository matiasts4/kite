# Terminal & Agent Runtime Benchmark Harness — Specification

Objective: Establish a deterministic, reproducible benchmark and telemetry capture harness that measures platform overhead (Host, Daemon, UI Renderer, GPU) separately from child PTY workloads across 1, 2, and 3 concurrent terminals and active agents.  
Branch: `feat/ui-composer`  
Delivery strategy: `ask-on-risk` | Test runner: `cargo test` (in `src-tauri`) & `npx vitest run`

---

## 1. Context & Problem Statement

Before committing to deep transport or UI-surface migrations, Kite requires an apples-to-apples measurement harness capable of capturing real resource consumption under controlled multi-terminal and multi-agent workloads.

### Why Ad-Hoc Process Snapshots Are Insufficient

1. **Workload Entanglement**:
   - Autonomous coding agents and developer shells spawn heavy child process trees (`node`, `cargo`, `rustc`, language servers). A raw process-tree sum conflates the agent's own memory footprint with Kite's platform overhead.
2. **Stale Historical Baselines**:
   - Earlier manual measurements predated event-driven terminal wakeups (`terminal://activity`), the 33 ms output clock (`OUTPUT_GAP_MS = 33`), hidden-pane suspension (`set_terminal_presentation`), dirty-row Canvas2D painting, and the in-process Rust update feed (`local_feed.rs`).
3. **Missing Data-Plane & Frame Counters**:
   - `src-tauri/src/system_metrics.rs` captures per-process `memoryBytes` (Working Set) and `privateBytes`, but does not record IPC snapshot frequency (`frames/s`), serialized payload throughput (`bytes/s`), VT parse time (`vt_feed_us`), or frontend canvas paint duration (`frame_paint_us`).

---

## 2. Architecture & Attribution Buckets

Every benchmark sample MUST partition processes into three mutually exclusive attribution buckets using the parent-PID walk in `src-tauri/src/system_metrics.rs`:

| Bucket ID | Bucket Name | Included Processes | Purpose |
| :--- | :--- | :--- | :--- |
| **`Bucket A`** | **Platform Overhead (Host + Core + UI)** | `kite-code.exe`, `kite-core.exe` (when detached), and all `msedgewebview2.exe` subprocesses (`Browser Host`, `Renderer`, `GPU Process`, `Utility`). | Measures the exact RAM and CPU cost of Kite itself. |
| **`Bucket B`** | **PTY Host Layer** | `conhost.exe` / `OpenConsole.exe` instances directly attached to Kite PTY sessions. | Isolates OS console host overhead per open terminal. |
| **`Bucket C`** | **User & Agent Workload Tree** | Shell roots (`pwsh.exe`, `cmd.exe`, `bash.exe`), autonomous agent binaries, and their descendant build/test processes. | Recorded for context but excluded from net platform overhead comparisons. |

---

## 3. Canonical Benchmark Scenarios (`E1`–`E4`)

Each scenario runs for a deterministic **60-second window** (first 15 s warm-up, final 45 s steady-state aggregation) at a fixed viewport (`1920x1080`, window focused and visible on the primary display, except `E4`):

### Scenario `E1` — Multi-Terminal Idle Baseline (1, 2, and 3 Terminals)
- **Setup**: Open $N \in \{1, 2, 3\}$ visible split terminal panes running an idle shell prompt with no active output.
- **Target Metrics**:
  - `Bucket A` and `Bucket B` Working Set (MB) and Private Commit (MB).
  - Steady-state CPU % over the final 45 s (target: `< 0.2%` idle CPU, `0` snapshot IPC calls/s).

### Scenario `E2` — Continuous 30 Hz Streaming & TUI Spinners (2 and 3 Terminals)
- **Setup**: Open $N \in \{2, 3\}$ visible split terminal panes running the built-in deterministic ANSI workload generator:
  - Sub-mode `E2-spinners`: 80×24 TUI status lines updating spinner glyphs and progress bars every 16 ms (coalesced by the 33 ms output clock).
  - Sub-mode `E2-logburst`: scrolling colored build log lines at 2,000 lines/sec per pane.
- **Target Metrics**:
  - `Bucket A` CPU % split between Rust host/core and WebView2 (`Renderer` + `GPU`).
  - IPC snapshot rate (`snapshots/s`, expected $\le 30\text{ Hz}$ per visible pane), IPC throughput (`KB/s`), and V8 heap delta after 60 s.
  - Frontend canvas draw latency (`frame_paint_us` p50, p95, p99).

### Scenario `E3` — Active Agent Orchestration + Build Pane (2 Agents + 1 Shell)
- **Setup**: 2 terminal panes running active agent sessions receiving dispatched prompts and streaming diffs + 1 terminal pane running a test watcher.
- **Target Metrics**:
  - Net `Bucket A` RAM and CPU overhead (excluding `Bucket C` agent binaries).
  - Input-to-paint latency (`key_input_to_paint_ms` p50, p95) while background panes stream.
  - Dispatch-to-PTY write latency (`dispatch_to_pty_us`).

### Scenario `E4` — Headless / Closed-Window Persistence (2 Active Agents, No GUI)
- **Setup**: Start 2 long-running agent workloads, close the main GUI window while keeping the session host alive (requires Phase 1 `kite-core` daemon), sample for 30 s headless, then reopen the window and reattach.
- **Target Metrics**:
  - Process survival rate (100% of `Bucket C` PIDs remain alive across window close/reopen).
  - Headless `Bucket A + Bucket B` RAM footprint (target: `< 45 MB` Working Set, `< 25 MB` Private Bytes with GUI closed).
  - Reattach latency (`window_launch_to_first_full_grid_ms`).

---

## 4. Data Contract & JSONL Telemetry Schema

### 4.1 Runtime Counter Record (`TerminalBenchSample`)

When `KITE_BENCH_LOG=<path.jsonl>` is set or the benchmark command is invoked via IPC (`start_terminal_benchmark` / `stop_terminal_benchmark`), Kite appends one JSONL record per second:

```ts
export interface BucketMemorySample {
  processCount: number;
  workingSetBytes: number;
  privateBytes: number;
  cpuPercent: number;
}

export interface TerminalDataPlaneCounters {
  activeTerminals: number;
  liveVisibleTerminals: number;
  ptyBytesReadPerSec: number;
  vtFeedCallsPerSec: number;
  vtFeedDurationUsP95: number;
  activityEventsEmittedPerSec: number;
  snapshotPollsPerSec: number;
  snapshotPayloadBytesPerSec: number;
  dirtyRowsPaintedPerSec: number;
  framePaintUsP50: number;
  framePaintUsP95: number;
  framePaintUsP99: number;
  inputToPaintMsP95: number;
}

export interface TerminalBenchSample {
  timestampUnixMs: number;
  scenarioId: 'E1-idle' | 'E2-spinners' | 'E2-logburst' | 'E3-agents' | 'E4-headless';
  terminalCount: number;
  elapsedSec: number;
  buckets: {
    platform: BucketMemorySample;   // Bucket A (Host + Core + WebView2)
    ptyHost: BucketMemorySample;    // Bucket B (ConPTY / OpenConsole)
    workload: BucketMemorySample;   // Bucket C (Shells + Agents + Compilers)
  };
  webviewSubBreakdown: {
    hostPrivateBytes: number;
    rendererPrivateBytes: number;
    gpuPrivateBytes: number;
  };
  dataPlane: TerminalDataPlaneCounters;
}
```

---

## Specs

- **S1 — Three-Bucket Process Attribution (`Bucket A / B / C`)**:
  - `WHEN` `collect_benchmark_sample` inspects the system process tree `THEN` it MUST classify every process into `platform` (`Bucket A`), `ptyHost` (`Bucket B`), or `workload` (`Bucket C`) without double-counting shared parent/child PIDs, reporting both `workingSetBytes`, `privateBytes`, and per-interval `cpuPercent` delta.
- **S2 — Deterministic Built-In ANSI Workload Generator**:
  - `WHEN` a benchmark run starts scenario `E2-spinners` or `E2-logburst` across $N \in \{1, 2, 3\}$ terminals `THEN` Kite MUST drive a deterministic ANSI generator at a fixed byte/frame rate so runs before and after architectural changes (JSON IPC vs Binary IPC vs Detached Core vs Native GPU Surface) are 100% reproducible.
- **S3 — Data-Plane & Frame Timing Instrumentation**:
  - `WHEN` `KITE_BENCH_LOG` is active `THEN` the backend and frontend MUST record atomic counters for `ptyBytesRead`, `vtFeedDurationUs`, `snapshotPolls`, `snapshotPayloadBytes`, `dirtyRowsPainted`, and `framePaintUs` (p50/p95/p99), with zero allocation overhead when `KITE_BENCH_LOG` is unset.
- **S4 — Automated Summary Report Generation**:
  - `WHEN` a 60-second scenario completes `THEN` the runner MUST emit both raw JSONL samples and a Markdown summary table comparing `Bucket A`, `Bucket B`, and `Bucket C` memory/CPU and data-plane latency percentiles.

## Tasks

- [x] **T1** (`S1`, `S3` | route: inline/delegated): Add atomic data-plane counters (`ptyBytesRead`, `vtFeedDurationUs`, `snapshotPolls`, `snapshotPayloadBytes`) and `Bucket A/B/C` CPU/memory aggregation in `src-tauri/src/system_metrics.rs` and `src-tauri/src/terminal.rs`.
- [x] **T2** (`S3` | route: inline/delegated): Add opt-in frontend frame-timing (`framePaintUs` p50/p95/p99 and `inputToPaintMs`) reporting in `src/components/views/terminal/canvas/useTerminalSnapshotPoller.ts` and `canvasGridRenderer.ts`.
- [x] **T3** (`S2`, `S4` | route: inline/delegated): Create deterministic benchmark runner script `scripts/bench-terminals.mjs` covering scenarios `E1`–`E4` (1, 2, and 3 terminals/agents) with Markdown report output.

## Verification

1. `cargo test --manifest-path src-tauri/Cargo.toml system_metrics`
2. `npx tsc --noEmit`
3. `npx vitest run src/components/views/terminal/canvas/terminalBenchMetrics.test.ts`
4. `node --test scripts/bench-terminals.test.mjs`
5. `node .kite/sanitizer/audit-references.mjs --check`

## Log

- **L1 (2026-11-03)**: User requested a real, apples-to-apples resource consumption comparison methodology and persistent ODD documentation covering 2–3 open terminals and active agents to evaluate Phase 1 (Core persistence and communication) and Phase 2 (Native GPU surface migration).
- **L2 (2026-11-03)**: Completed initial Phase 0 implementation across backend, frontend, and benchmarking harness.
- **L3 (2026-11-03)**: Audited Phase 0 implementation, found 6 critical/high defects, and remediated all of them:
  1. **Zero-Allocation Hot-Path Gate (`S3`)**: Added `BENCH_ACTIVE` (`AtomicBool`) in `src-tauri/src/terminal.rs` so `bench_record_*`, `BENCH_VT_FEED_DURATIONS` locking/allocation, and `poll_terminal_snapshot_sync` payload-size JSON serialization are strict no-ops when benchmarking is inactive.
  2. **Parent-PID Lineage Attribution (`S1`)**: Added `get_terminal_root_pids()` and `classify_process_bucket_with_lineage` + `has_terminal_root_ancestor` in `src-tauri/src/system_metrics.rs` so descendants of terminal sessions are attributed to `Bucket C` (`Workload`), console hosts to `Bucket B` (`PtyHost`), and host/WebView processes to `Bucket A` (`Platform`).
  3. **Dedicated Benchmark CPU Timeline & Writer Generation Guard (`S1`, `S3`)**: Separated `bench_cpu_state()` from the UI's `cpu_state()` so UI polling never zeroes out benchmark CPU deltas (`elapsed < 0.25`), added `BenchmarkState.generation` to prevent duplicate 1 Hz writer threads, reset counters on start, and enforced a 3-second staleness TTL on frontend metrics.
  4. **Frontend Benchmark Bridge & Non-Destructive Window Reads (`S3`)**: Included `benchmarkActive` in `poll_terminal_snapshot` responses, mirrored it into `setTerminalBenchmarkActive` in `useTerminalSnapshotPoller.ts`, removed the per-frame 30 Hz `reportMetricsToBackend()` call that was resetting the 1s dirty-row window every 33 ms, and split `peekFrontendBenchMetrics()` vs `flushFrontendBenchMetrics()` in `terminalBenchMetrics.ts`.
  5. **Real Workload & Live Process Sampling in `scripts/bench-terminals.mjs` (`S2`, `S4`)**: Replaced unconditional synthetic loop and hardcoded report claims with live PowerShell process-tree sampling + real `workload-generator.mjs` byte streaming, interpolated steady-state percentiles (`p50/p95/p99`), dynamic `PASS`/`FAIL` threshold checks, and an explicit `Synthetic Dry-Run` banner when `--dry-run` is used.
  6. **Repository Cleanliness**: Removed fabricated `bench-results/` artifacts and added `bench-results/` to `.gitignore`.
  - **Verification**: `cargo test system_metrics` (12 passed), `node --test scripts/bench-terminals.test.mjs` (24 passed), `npx vitest run terminalBenchMetrics.test.ts` (11 passed), `npx tsc --noEmit` (clean), and `audit-references.mjs --check` (`[CLEAN]`).
- **L4 (2026-11-03)**: Executed live runtime benchmark evaluation across scenarios `E1`–`E4` and fixed a process-tree scoping bug in `scripts/bench-terminals.mjs`:
  - Added `parentId` to `queryProcessSnapshot()` and implemented `filterKiteProcessTree(processes, { headlessOnly })` so live sampling isolates a single Kite instance tree (and isolates only `kite-core --daemon` during `E4-headless`) instead of summing unrelated system-wide processes.
  - **Observed Live Hardware Results (Windows x64, 3 Terminals)**:
    - `E1-idle` (3 Terminals, GUI Open): `Bucket A` Working Set = **`590.1 MB`**, Private Bytes = **`301.2 MB`**, CPU = **`0.08%`** (`PASS`, target `< 0.2%`); `Bucket B` (`conhost.exe`) Working Set = **`43.7 MB`**, CPU = **`0.02%`**.
    - `E2-spinners` (3 Terminals, 30 Hz): `Bucket A` Working Set = **`592.0 MB`**, Private Bytes = **`303.1 MB`**, CPU = **`0.17%`**.
    - `E2-logburst` (3 Terminals, 30 Hz): `Bucket A` Working Set = **`591.3 MB`**, Private Bytes = **`302.4 MB`**, CPU = **`0.15%`**.
    - `E4-headless` (Window Closed, `kite-core --daemon` live): `Bucket A` Working Set = **`24.6 MB`** (`PASS`, target `< 45 MB`), Private Bytes = **`11.1 MB`** (`PASS`, target `< 40 MB`), CPU = **`0.00%`**.
