# Granular Process & Memory Telemetry — Specification

Status: in progress on `feat/ui-composer`.

## 1. Context & Problem Statement

Kite Code features a top-bar resource monitor (`SystemResourceBadge` and `SystemResourcePopover`) that monitors app and system health. However, as developers manage multi-workspace sessions, run autonomous agents, and trigger background builds and tests, resource consumption frequently scales to dozens of child processes (e.g., 60–90 subprocesses) and significant memory footprints (1.5–2.5 GB).

### Limitations of Current Telemetry

1. **Flat, Opaque Process Listing**:
   - All child processes detected under the host process tree are lumped into a single flat list or three broad buckets (`core`, `webview`, `terminals`).
   - Subprocesses are identified only by basic executable name pattern matches (`infer_process_label`), without context regarding which workspace or session spawned them.

2. **No Project / Workspace Attribution**:
   - When multiple project workspaces are active, users cannot distinguish whether memory is being consumed by Project A (e.g., active Next.js dev server + Jest runner) or Project B (e.g., Rust compilation with `cargo` and `rustc`).

3. **No Distinction Between Agent and Manual Terminals**:
   - Autonomous AI agents (such as Antigravity CLI, Claude Code, Grok) and manual interactive terminals (PowerShell, CMD, Bash) are grouped indiscriminately under `terminals`.

4. **Transient & Orphan Process Blind Spots**:
   - Toolchains (`cargo`, `rustc`, `node`, `vitest`, `esbuild`) frequently spawn short-lived or lingering child processes. If a process lingers after a test or build phase finishes, the user cannot easily spot or terminate the orphan.

---

## 2. Product Goals & Architectural Solution

### Product Goals

- **Workspace Attribution**: Aggregate RAM and child processes by workspace/project so users immediately know which repository is driving resource usage.
- **Agent vs. Terminal Granularity**: Categorize terminal sessions into AI Agents (with their engine name, active status, and agent title) versus interactive shells.
- **Tree Hierarchy**: Resolve child process parentage (`parentPid`) back to the originating PTY root process so that compiler workers (`rustc`), bundlers (`esbuild`), and CLI tools are visually attributed to the exact terminal pane that started them.
- **Memory Transparency**: Distinguish between *Private Bytes* (memory exclusively allocated to the process) and *Working Set* (total physical RAM mapped, including shared OS libraries).
- **Orphan Detection & Quick Recovery**: Flag detached or orphaned processes whose parent terminal is no longer registered, providing a one-click action to kill them without restarting Kite.

---

## 3. Data Contract & Schema

### 3.1 Backend Data Contract (`src-tauri/src/system_metrics.rs`)

The `get_system_metrics` Tauri command returns enriched telemetry:

```ts
export interface DetailedProcessMetric {
  pid: number;
  parentPid?: number;
  name: string;
  label?: string;
  category: 'core' | 'webview' | 'agent' | 'terminal' | 'build';
  memoryBytes: number;
  privateBytes?: number;
  sessionId?: string;
  workspaceId?: string;
  engine?: string;
  isOrphan?: boolean;
}

export interface WorkspaceMetricsGroup {
  workspaceId: string;
  displayName: string;
  memoryBytes: number;
  privateBytes?: number;
  processCount: number;
  terminalCount: number;
}

export interface TerminalMetricsGroup {
  sessionId: string;
  title: string;
  engine: string;
  workspaceId?: string;
  isAgent: boolean;
  rootPid: number;
  memoryBytes: number;
  privateBytes?: number;
  processCount: number;
  state?: string;
}

export interface SystemMetricsSnapshot {
  // Existing system, memory, cpu, disk fields...
  runtime: {
    activeTerminals: number;
    processCount: number;
    breakdown: ProcessGroupBreakdown[];
    processes?: DetailedProcessMetric[];
    workspaces?: WorkspaceMetricsGroup[];
    terminals?: TerminalMetricsGroup[];
  };
}
```

---

## 4. Implementation Plan

### Phase 1: Rust Backend Enrichment (`src-tauri/src/system_metrics.rs`)
- In `collect_snapshot()`:
  - Query active terminals from `crate::terminal::get_terminals()`.
  - Build a lookup table from `terminal.child.process_id()` -> `(sessionId, workspaceId, engine)`.
  - For each process in the collected tree, trace ancestors upward to find if any ancestor is a terminal root PID.
  - Categorize:
    - Root PID / `kite-code.exe` -> `'core'`
    - WebView2 (`msedgewebview2.exe`) -> `'webview'`
    - Processes with terminal ancestor matching an agent engine -> `'agent'`
    - Processes with terminal ancestor matching standard shells -> `'terminal'`
    - Build tool names (`rustc`, `cargo`, `esbuild`, `tsc`, `link`) -> `'build'`
  - Aggregate sums for `workspaces` and `terminals`.

### Phase 2: Frontend Types & Normalization (`src/lib/systemMetrics.ts`)
- Update `SystemMetricsSnapshot` and fallback mock generator to support `workspaces` and `terminals`.
- Enrich display labels using `terminalRegistry.ts` (matching agent codenames and workspace display titles).

### Phase 3: Popover UI Enhancements (`src/components/telemetry/SystemResourcePopover.tsx`)
- Enhance the **Memory** tab with grouped views:
  - **Por Proyecto**: Collapsible accordion showing memory and process breakdown per workspace.
  - **Por Terminal & Agente**: Grouped list showing AI Agent runners vs. user terminals with process trees.
  - **Lista Detallada**: Searchable flat list with category filter and kill-process capability.
- Add orphan process alert banner with a button to terminate orphan subtrees.

### Phase 4: Verification & Compliance
- Validate styling adheres strictly to `AGENTS.md` (no arbitrary radii, standard 28px/32px control heights, titlebar mode switcher untouched).
- Verify type checks with `npx tsc --noEmit`.
- Run tests with `npx vitest run`.
- Audit sanitized references with `node .kite/sanitizer/audit-references.mjs --check`.
