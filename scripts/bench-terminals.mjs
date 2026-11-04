#!/usr/bin/env node
/**
 * Terminal & Agent Runtime Benchmark Harness
 *
 * Runs the canonical scenarios E1-E4 across 1, 2 and 3 terminals/agents, records
 * one JSONL telemetry sample per second and emits a Markdown summary report.
 *
 * Modes:
 *   live (default)  Drives the deterministic ANSI workload generator against
 *                   every virtual terminal stream, samples the real OS process
 *                   tree (Bucket A/B/C) and records measured PTY throughput.
 *   dry-run         (--dry-run) Emits schema-valid simulated samples so the
 *                   harness itself can be verified without a running app.
 *   replay          (--input <jsonl>) Aggregates samples captured by the app
 *                   (KITE_BENCH_LOG) instead of running a live scenario.
 *
 * Usage:
 *   node scripts/bench-terminals.mjs
 *   node scripts/bench-terminals.mjs --scenario E2-spinners --terminals 3 --seconds 60
 *   node scripts/bench-terminals.mjs --dry-run --seconds 5
 *   node scripts/bench-terminals.mjs --input bench-results/samples.jsonl
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runWorkload } from './benchmarks/workload-generator.mjs';

const GENERATOR_SCRIPT = fileURLToPath(new URL('./benchmarks/workload-generator.mjs', import.meta.url));
const VIEWPORT = { cols: 80, rows: 24 };
const SYNTHETIC_BANNER =
  '> ⚠️ **Mode: Synthetic Dry-Run** — Values below are simulated for harness verification and do not represent live hardware measurements.';
const POWERSHELL_TIMEOUT_MS = 15000;
const POWERSHELL_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export const SCENARIO_MATRIX = [
  { id: 'E1-idle', terminals: 1, name: 'E1-idle (1 Terminal)' },
  { id: 'E1-idle', terminals: 2, name: 'E1-idle (2 Terminals)' },
  { id: 'E1-idle', terminals: 3, name: 'E1-idle (3 Terminals)' },
  { id: 'E2-spinners', terminals: 2, name: 'E2-spinners (2 Terminals)' },
  { id: 'E2-spinners', terminals: 3, name: 'E2-spinners (3 Terminals)' },
  { id: 'E2-logburst', terminals: 2, name: 'E2-logburst (2 Terminals)' },
  { id: 'E2-logburst', terminals: 3, name: 'E2-logburst (3 Terminals)' },
  { id: 'E3-agents', terminals: 3, name: 'E3-agents (2 Agents + 1 Shell)' },
  { id: 'E4-headless', terminals: 2, name: 'E4-headless (2 Agents Persistence)' },
];

const SCENARIO_WORKLOAD_MODE = {
  'E1-idle': 'idle',
  'E2-spinners': 'spinners',
  'E2-logburst': 'logburst',
  'E3-agents': 'agents',
  'E4-headless': 'agents',
};

export function parseArgs(argv) {
  const args = {
    scenario: 'all',
    terminals: null,
    terminalsExplicit: false,
    seconds: 60,
    intervalMs: 1000,
    input: null,
    output: path.join(process.cwd(), 'bench-results', 'samples.jsonl'),
    report: path.join(process.cwd(), 'bench-results', 'summary.md'),
    dryRun: false,
  };

  const positiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--scenario' && argv[i + 1]) args.scenario = argv[++i];
    else if (arg === '--terminals' && argv[i + 1]) {
      args.terminals = positiveInt(argv[++i], null);
      args.terminalsExplicit = args.terminals != null;
    } else if (arg === '--seconds' && argv[i + 1]) args.seconds = positiveInt(argv[++i], args.seconds);
    else if (arg === '--interval-ms' && argv[i + 1]) args.intervalMs = positiveInt(argv[++i], args.intervalMs);
    else if (arg === '--input' && argv[i + 1]) args.input = argv[++i];
    else if (arg === '--output' && argv[i + 1]) args.output = argv[++i];
    else if (arg === '--report' && argv[i + 1]) args.report = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
  }
  return args;
}

export function resolveScenarios(args) {
  const pool =
    args.scenario === 'all'
      ? SCENARIO_MATRIX
      : SCENARIO_MATRIX.filter((s) => s.id === args.scenario || s.id.startsWith(args.scenario));
  if (!args.terminalsExplicit || args.terminals == null) {
    return pool;
  }
  const seen = new Set();
  const overridden = [];
  for (const scenario of pool) {
    if (seen.has(scenario.id)) continue;
    seen.add(scenario.id);
    overridden.push({
      id: scenario.id,
      terminals: args.terminals,
      name: `${scenario.id} (${args.terminals} Terminal${args.terminals === 1 ? '' : 's'})`,
    });
  }
  return overridden;
}

export function toMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

export function classifyProcess(name) {
  const lower = (name || '').toLowerCase();
  if (lower.includes('conhost') || lower.includes('openconsole')) {
    return 'ptyHost'; // Bucket B
  } else if (lower.includes('kite') || lower.includes('webview') || lower.includes('msedge')) {
    return 'platform'; // Bucket A
  }
  return 'workload'; // Bucket C
}

function isWebviewProcess(name) {
  const lower = (name || '').toLowerCase();
  return lower.includes('msedgewebview2') || lower.includes('webview');
}

function webviewRole(processInfo) {
  const commandLine = String(processInfo.commandLine || '').toLowerCase();
  if (commandLine.includes('--type=gpu-process')) return 'gpuPrivateBytes';
  if (commandLine.includes('--type=renderer')) return 'rendererPrivateBytes';
  return 'hostPrivateBytes';
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const clamped = Math.min(1, Math.max(0, p));
  const rank = (sorted.length - 1) * clamped;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function aggregateSteadyState(samples, warmupSec = 15) {
  // Steady state is samples with elapsedSec >= warmupSec
  const steady = samples.filter((s) => s.elapsedSec >= warmupSec);
  const data = steady.length > 0 ? steady : samples;

  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const series = (pick) => data.map(pick);
  const dataPlane = (sample, key) => Number(sample?.dataPlane?.[key] ?? 0);

  const paintP50 = series((s) => dataPlane(s, 'framePaintUsP50'));
  const paintP95 = series((s) => dataPlane(s, 'framePaintUsP95'));
  const paintP99 = series((s) => dataPlane(s, 'framePaintUsP99'));

  return {
    sampleCount: data.length,
    terminalCount: data[0]?.terminalCount ?? 0,
    synthetic: data.some((s) => s.synthetic === true),
    // 'harness' means the counters came from a live harness run, which can only
    // observe PTY throughput; app IPC and frame counters must be replayed.
    counterSource: data.length > 0 && data.every((s) => s.counterSource === 'harness') ? 'harness' : 'app',
    platformWsMb: mean(series((s) => s.buckets.platform.workingSetBytes / (1024 * 1024))),
    platformPrivMb: mean(series((s) => s.buckets.platform.privateBytes / (1024 * 1024))),
    platformCpuPct: mean(series((s) => s.buckets.platform.cpuPercent)),
    platformProcessCount: data[data.length - 1]?.buckets.platform.processCount ?? 0,
    ptyWsMb: mean(series((s) => s.buckets.ptyHost.workingSetBytes / (1024 * 1024))),
    ptyPrivMb: mean(series((s) => s.buckets.ptyHost.privateBytes / (1024 * 1024))),
    ptyCpuPct: mean(series((s) => s.buckets.ptyHost.cpuPercent)),
    workloadWsMb: mean(series((s) => s.buckets.workload.workingSetBytes / (1024 * 1024))),
    workloadPrivMb: mean(series((s) => s.buckets.workload.privateBytes / (1024 * 1024))),
    workloadCpuPct: mean(series((s) => s.buckets.workload.cpuPercent)),
    paintP50Us: percentile(paintP50, 0.5),
    paintP95Us: percentile(paintP95, 0.95),
    paintP99Us: percentile(paintP99, 0.99),
    vtFeedP95Us: percentile(series((s) => dataPlane(s, 'vtFeedDurationUsP95')), 0.95),
    inputToPaintP95Ms: percentile(series((s) => dataPlane(s, 'inputToPaintMsP95')), 0.95),
    snapshotPollsPerSec: mean(series((s) => dataPlane(s, 'snapshotPollsPerSec'))),
    snapshotPayloadKbPerSec: mean(series((s) => dataPlane(s, 'snapshotPayloadBytesPerSec') / 1024)),
    ptyKbReadPerSec: mean(series((s) => dataPlane(s, 'ptyBytesReadPerSec') / 1024)),
    vtFeedCallsPerSec: mean(series((s) => dataPlane(s, 'vtFeedCallsPerSec'))),
  };
}

function verdict(ok) {
  return ok ? '**PASS**' : '**FAIL**';
}

function buildFindings(results) {
  const lines = [];

  const idle = results.filter((r) => r.scenario === 'E1-idle');
  if (idle.length) {
    lines.push('### Idle Baseline (E1)');
    for (const r of idle) {
      const cpuOk = r.metrics.platformCpuPct < 0.2;
      const polls =
        r.metrics.counterSource === 'harness'
          ? 'snapshot polls **not measured** (app IPC counter; replay with `--input <jsonl>`)'
          : `snapshot polls **${r.metrics.snapshotPollsPerSec.toFixed(1)}/s** (target 0/s) → ${verdict(
              r.metrics.snapshotPollsPerSec === 0
            )}`;
      lines.push(
        `- **${r.name}** — Bucket A CPU **${r.metrics.platformCpuPct.toFixed(2)}%** (target < 0.2%) → ${verdict(
          cpuOk
        )}; ${polls}`
      );
    }
    lines.push('');
  }

  const streaming = results.filter((r) => r.scenario === 'E2-spinners' || r.scenario === 'E2-logburst');
  if (streaming.length) {
    lines.push('### 30 Hz Streaming (E2)');
    for (const r of streaming) {
      const budget = 30 * r.terminals;
      const panes = `${r.terminals} pane${r.terminals === 1 ? '' : 's'}`;
      if (r.metrics.counterSource === 'harness') {
        lines.push(
          `- **${r.name}** — snapshot polls **not measured** (app IPC counter; replay with \`--input <jsonl>\` to evaluate the ${budget}/s = 30 Hz × ${panes} target)`
        );
      } else {
        const snapshotOk = r.metrics.snapshotPollsPerSec <= budget;
        lines.push(
          `- **${r.name}** — snapshot polls **${r.metrics.snapshotPollsPerSec.toFixed(
            1
          )}/s** (target ≤ ${budget}/s = 30 Hz × ${panes}) → ${verdict(snapshotOk)}`
        );
      }
      if (r.metrics.paintP95Us > 0) {
        const paintOk = r.metrics.paintP95Us < 2500;
        lines.push(
          `- **${r.name}** — canvas frame paint p95 **${r.metrics.paintP95Us.toFixed(
            0
          )} μs** (target < 2,500 μs) → ${verdict(paintOk)}`
        );
      }
    }
    lines.push('');
  }

  const headless = results.filter((r) => r.scenario === 'E4-headless');
  if (headless.length) {
    lines.push('### Headless Persistence (E4)');
    for (const r of headless) {
      const wsOk = r.metrics.platformWsMb < 45;
      lines.push(
        `- **${r.name}** — Bucket A Working Set **${r.metrics.platformWsMb.toFixed(
          1
        )} MB** (target < 45 MB) → ${verdict(wsOk)}`
      );
    }
    lines.push('');
  }

  const coverage = [];
  if (results.some((r) => r.metrics.paintP95Us === 0)) {
    coverage.push(
      '- `framePaintUs` and `inputToPaintMs` read `0` when the app telemetry did not report them; capture them with `KITE_BENCH_LOG` and replay through `--input <jsonl>`.'
    );
  }
  if (results.some((r) => !r.metrics.synthetic && (r.metrics.platformProcessCount ?? 0) === 0)) {
    coverage.push(
      '- Bucket A captured `0` platform processes for a live run; start Kite Code while sampling or replay captured telemetry through `--input <jsonl>`.'
    );
  }
  if (coverage.length) {
    lines.push('### Measurement Coverage');
    lines.push(...coverage);
    lines.push('');
  }

  return lines;
}

export function generateMarkdownReport(results, options = {}) {
  const synthetic = results.some((r) => r.metrics?.synthetic === true);
  const lines = [
    '# Terminal & Agent Runtime Benchmark Report',
    '',
    `Generated at: ${new Date().toISOString()}`,
    `Evaluation Window: ${options.windowLabel ?? '60s per scenario (15s warm-up discarded, 45s steady state aggregation)'}`,
    '',
  ];

  if (synthetic) {
    lines.push(SYNTHETIC_BANNER, '');
  }

  lines.push(
    '## 1. Executive Summary Table',
    '',
    '| Scenario | Terminals | Bucket A WS (MB) | Bucket A Priv (MB) | Bucket A CPU % | Bucket B WS (MB) | Bucket B CPU % | Bucket C WS (MB) | Paint p95 (μs) | Paint p99 (μs) | VT Feed p95 (μs) | Input-Paint p95 (ms) | PTY KB/s | Snapshots/s |',
    '| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |'
  );

  for (const r of results) {
    const m = r.metrics;
    lines.push(
      `| **${r.scenario}** | ${r.terminals} | ${m.platformWsMb.toFixed(1)} MB | ${m.platformPrivMb.toFixed(
        1
      )} MB | ${m.platformCpuPct.toFixed(2)}% | ${m.ptyWsMb.toFixed(1)} MB | ${m.ptyCpuPct.toFixed(
        2
      )}% | ${m.workloadWsMb.toFixed(1)} MB | ${m.paintP95Us.toFixed(0)} μs | ${m.paintP99Us.toFixed(
        0
      )} μs | ${m.vtFeedP95Us.toFixed(0)} μs | ${m.inputToPaintP95Ms.toFixed(1)} ms | ${m.ptyKbReadPerSec.toFixed(
        1
      )} KB/s | ${m.snapshotPollsPerSec.toFixed(1)}/s |`
    );
  }

  lines.push('');
  lines.push('## 2. Platform Overhead Attribution (Bucket A vs B vs C)');
  lines.push('');
  lines.push('- **Bucket A (Platform Overhead)**: Net Kite host (`kite-code.exe`) + WebView2 runtime (`Browser Host`, `Renderer`, `GPU Process`).');
  lines.push('- **Bucket B (PTY Host Layer)**: OS console host (`conhost.exe` / `OpenConsole.exe`).');
  lines.push('- **Bucket C (User & Agent Workloads)**: Developer shells, autonomous agent binaries, and test/compiler processes.');
  lines.push('');
  lines.push('## 3. Findings & Validation Against Targets');
  lines.push('');
  const findings = buildFindings(results);
  if (findings.length === 0) {
    findings.push('- No scenarios matched the requested filter, so no target was evaluated.');
  }
  lines.push(...findings);

  return lines.join('\n');
}

export function synthesizeSample(scenarioId, elapsedSec, terminalCount) {
  const isIdle = scenarioId.includes('idle');
  const isSpinners = scenarioId.includes('spinners');
  const isLogburst = scenarioId.includes('logburst');
  const isAgents = scenarioId.includes('agents');
  const isHeadless = scenarioId.includes('headless');

  const basePlatformWs = isHeadless ? 42 * 1024 * 1024 : (340 + terminalCount * 12) * 1024 * 1024;
  const basePlatformPriv = isHeadless ? 22 * 1024 * 1024 : (180 + terminalCount * 8) * 1024 * 1024;
  const platformCpu = isIdle ? 0.04 : isSpinners ? 0.85 * terminalCount : isLogburst ? 1.45 * terminalCount : isAgents ? 1.10 : 0.02;

  const ptyWs = terminalCount * 14 * 1024 * 1024;
  const ptyPriv = terminalCount * 8 * 1024 * 1024;
  const ptyCpu = isIdle ? 0.0 : isSpinners ? 0.12 * terminalCount : isLogburst ? 0.35 * terminalCount : 0.08;

  const workloadWs = (isAgents ? 140 : 45) * terminalCount * 1024 * 1024;
  const workloadPriv = (isAgents ? 85 : 24) * terminalCount * 1024 * 1024;
  const workloadCpu = isIdle ? 0.0 : isSpinners ? 0.25 : isLogburst ? 0.8 : 2.5;

  const paintP50 = isIdle || isHeadless ? 0.0 : 480.0;
  const paintP95 = isIdle || isHeadless ? 0.0 : 1250.0;
  const paintP99 = isIdle || isHeadless ? 0.0 : 2100.0;
  const inputToPaintP95 = isIdle || isHeadless ? 0.0 : 18.5;

  const snapshotPolls = isIdle || isHeadless ? 0.0 : 30.0 * terminalCount;
  const snapshotPayload = isIdle || isHeadless ? 0 : 28 * 1024 * terminalCount;
  const ptyBytesRead = isIdle ? 0 : isLogburst ? 180 * 1024 * terminalCount : 24 * 1024 * terminalCount;

  return {
    timestampUnixMs: Date.now(),
    scenarioId,
    terminalCount,
    elapsedSec,
    synthetic: true,
    buckets: {
      platform: {
        processCount: isHeadless ? 1 : 4,
        workingSetBytes: basePlatformWs,
        privateBytes: basePlatformPriv,
        cpuPercent: platformCpu,
      },
      ptyHost: {
        processCount: terminalCount,
        workingSetBytes: ptyWs,
        privateBytes: ptyPriv,
        cpuPercent: ptyCpu,
      },
      workload: {
        processCount: terminalCount * 2,
        workingSetBytes: workloadWs,
        privateBytes: workloadPriv,
        cpuPercent: workloadCpu,
      },
    },
    webviewSubBreakdown: {
      hostPrivateBytes: isHeadless ? 0 : 68 * 1024 * 1024,
      rendererPrivateBytes: isHeadless ? 0 : 142 * 1024 * 1024,
      gpuPrivateBytes: isHeadless ? 0 : 45 * 1024 * 1024,
    },
    dataPlane: {
      activeTerminals: terminalCount,
      liveVisibleTerminals: isHeadless ? 0 : terminalCount,
      ptyBytesReadPerSec: ptyBytesRead,
      vtFeedCallsPerSec: isIdle ? 0 : 60 * terminalCount,
      vtFeedDurationUsP95: isIdle ? 0.0 : 240.0,
      activityEventsEmittedPerSec: isIdle ? 0 : 30 * terminalCount,
      snapshotPollsPerSec: snapshotPolls,
      snapshotPayloadBytesPerSec: snapshotPayload,
      dirtyRowsPaintedPerSec: isIdle ? 0 : 45 * terminalCount,
      framePaintUsP50: paintP50,
      framePaintUsP95: paintP95,
      framePaintUsP99: paintP99,
      inputToPaintMsP95: inputToPaintP95,
    },
  };
}

const EMPTY_BUCKET = () => ({ processCount: 0, workingSetBytes: 0, privateBytes: 0, cpuPercent: 0 });
const EMPTY_WEBVIEW_BREAKDOWN = () => ({ hostPrivateBytes: 0, rendererPrivateBytes: 0, gpuPrivateBytes: 0 });

/**
 * Reads the live OS process tree through PowerShell so Bucket A/B/C attribution
 * reflects real hardware. Returns null when the platform or the query is
 * unavailable, which lets the caller fall back cleanly instead of failing.
 */
function queryProcessSnapshot() {
  if (process.platform !== 'win32') {
    return Promise.resolve(null);
  }

  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$cpu = @{}',
    'Get-Process | ForEach-Object { $cpu[[int]$_.Id] = @($_.TotalProcessorTime.TotalSeconds, $_.PrivateMemorySize64) }',
    '$rows = Get-CimInstance Win32_Process | ForEach-Object {',
    '  $entry = $cpu[[int]$_.ProcessId]',
    '  [pscustomobject]@{ id = [int]$_.ProcessId; parentId = [int]$_.ParentProcessId; name = $_.Name; workingSetBytes = [int64]$_.WorkingSetSize; commandLine = $_.CommandLine; cpuSeconds = [double]($entry[0]); privateBytes = [int64]($entry[1]) }',
    '}',
    'ConvertTo-Json -InputObject @($rows) -Compress -Depth 3',
  ].join('\n');

  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, POWERSHELL_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > POWERSHELL_MAX_BUFFER_BYTES) {
        child.kill();
        finish(null);
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0) return finish(null);
      try {
        const parsed = JSON.parse(stdout);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        finish(rows.filter((row) => row && row.name));
      } catch {
        finish(null);
      }
    });
  });
}

/**
 * Filters a system-wide process snapshot down to a single Kite instance tree
 * (one GUI host + its WebView2 children + any detached `kite-core` / `--daemon`
 * process and their PTY/workload descendants), preventing unrelated system
 * processes or secondary Kite installations from inflating Buckets A/B/C.
 */
export function filterKiteProcessTree(processes, options = {}) {
  if (!Array.isArray(processes) || processes.length === 0) return [];
  if (!processes.some((p) => typeof p?.parentId === 'number')) {
    return processes;
  }

  const headlessOnly = options.headlessOnly === true;
  const kiteProcs = processes.filter((p) => {
    const n = String(p.name || '').toLowerCase();
    const cmd = String(p.commandLine || '').toLowerCase();
    if (!n.includes('kite-code') && !n.includes('kite-core') && !n.includes('kite_code')) {
      return false;
    }
    if (cmd.includes('mcp tasks') || cmd.includes(' dispatch ')) {
      return false;
    }
    return true;
  });

  if (kiteProcs.length === 0) return [];

  const daemonRoots = kiteProcs.filter((p) => {
    const n = String(p.name || '').toLowerCase();
    const cmd = String(p.commandLine || '').toLowerCase();
    return n.includes('kite-core') || cmd.includes('--daemon');
  });

  const guiCandidates = kiteProcs.filter((p) => !daemonRoots.includes(p));
  const workspaceGui = guiCandidates.filter((p) =>
    String(p.commandLine || '').toLowerCase().includes('src-tauri')
  );
  const chosenGuiPool = workspaceGui.length > 0 ? workspaceGui : guiCandidates;
  const primaryGui =
    chosenGuiPool.length > 0
      ? chosenGuiPool.reduce((best, cur) => (cur.id > best.id ? cur : best), chosenGuiPool[0])
      : null;

  const rootIds = new Set();
  for (const d of daemonRoots) rootIds.add(d.id);
  if (!headlessOnly && primaryGui) {
    rootIds.add(primaryGui.id);
  }

  if (rootIds.size === 0) return [];

  const included = new Set(rootIds);
  let added = true;
  while (added) {
    added = false;
    for (const p of processes) {
      if (!included.has(p.id) && included.has(p.parentId)) {
        // If a GUI child spawned the daemon, avoid pulling GUI siblings during headlessOnly
        if (headlessOnly && primaryGui && p.id === primaryGui.id) continue;
        included.add(p.id);
        added = true;
      }
    }
  }

  return processes.filter((p) => included.has(p.id));
}

/**
 * Samples Bucket A/B/C memory and CPU deltas from the real process tree.
 * CPU percent is derived from TotalProcessorTime deltas between samples so the
 * reported value is per-interval usage rather than lifetime average.
 */
export function createProcessSampler(options = {}) {
  let previousCpu = new Map();
  let previousAtMs = null;

  return {
    async sample() {
      const rawProcesses = await queryProcessSnapshot();
      const processes = rawProcesses ? filterKiteProcessTree(rawProcesses, options) : null;
      const nowMs = Date.now();

      if (!processes || processes.length === 0) {
        previousAtMs = nowMs;
        return {
          platform: EMPTY_BUCKET(),
          ptyHost: EMPTY_BUCKET(),
          workload: EMPTY_BUCKET(),
          webviewSubBreakdown: EMPTY_WEBVIEW_BREAKDOWN(),
          source: 'unavailable',
        };
      }

      const elapsedSec = previousAtMs == null ? 0 : Math.max(0.001, (nowMs - previousAtMs) / 1000);
      const cpuCount = Math.max(1, os.cpus().length);
      const buckets = { platform: EMPTY_BUCKET(), ptyHost: EMPTY_BUCKET(), workload: EMPTY_BUCKET() };
      const cpuDelta = { platform: 0, ptyHost: 0, workload: 0 };
      const webviewSubBreakdown = EMPTY_WEBVIEW_BREAKDOWN();
      const nextCpu = new Map();

      for (const processInfo of processes) {
        const bucket = classifyProcess(processInfo.name);
        const target = buckets[bucket];
        target.processCount += 1;
        target.workingSetBytes += Number(processInfo.workingSetBytes) || 0;
        target.privateBytes += Number(processInfo.privateBytes) || 0;

        const cpuSeconds = Number(processInfo.cpuSeconds) || 0;
        nextCpu.set(processInfo.id, cpuSeconds);
        const previous = previousCpu.get(processInfo.id);
        if (previous != null && cpuSeconds >= previous) {
          cpuDelta[bucket] += cpuSeconds - previous;
        }

        if (bucket === 'platform' && isWebviewProcess(processInfo.name)) {
          webviewSubBreakdown[webviewRole(processInfo)] += Number(processInfo.privateBytes) || 0;
        }
      }

      if (elapsedSec > 0) {
        for (const key of Object.keys(buckets)) {
          buckets[key].cpuPercent = (cpuDelta[key] / (elapsedSec * cpuCount)) * 100;
        }
      }

      previousCpu = nextCpu;
      previousAtMs = nowMs;
      return { ...buckets, webviewSubBreakdown, source: 'windows-powershell' };
    },
    dispose() {},
  };
}

let optionsApiProbe = null;

/**
 * The harness targets the options-object workload API
 * (`runWorkload({ mode, durationMs, cols, rows, onWrite })`). Generators that
 * only expose the legacy positional stdout API throw before writing anything,
 * so the probe is a side-effect free capability check.
 */
async function supportsOptionsWorkloadApi() {
  if (optionsApiProbe !== null) return optionsApiProbe;
  try {
    await runWorkload({ mode: 'spinners', durationMs: 0, cols: VIEWPORT.cols, rows: VIEWPORT.rows, paneId: 0, onWrite: () => {} });
    optionsApiProbe = true;
  } catch {
    optionsApiProbe = false;
  }
  return optionsApiProbe;
}

function runLegacyGeneratorStream({ mode, durationMs, paneId, onWrite }) {
  return new Promise((resolve, reject) => {
    const durationSec = Math.max(0.1, durationMs / 1000);
    const child = spawn(process.execPath, [GENERATOR_SCRIPT, mode, String(durationSec), String(paneId)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.on('data', (chunk) => onWrite(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`workload generator exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Default workload driver: one deterministic ANSI stream per virtual terminal.
 * Every byte handed to `onWrite` is produced by the workload generator, so PTY
 * throughput and VT feed rates are measured rather than synthesized.
 */
export async function defaultWorkloadRunner(request) {
  const { mode, durationMs, cols, rows, paneId = 1, onWrite } = request;
  if (typeof onWrite !== 'function') {
    throw new TypeError('workload runner requires an onWrite callback');
  }

  if (await supportsOptionsWorkloadApi()) {
    await runWorkload({ mode, durationMs, durationSec: durationMs / 1000, cols, rows, paneId, onWrite });
    return;
  }

  await runLegacyGeneratorStream({ mode, durationMs, paneId, onWrite });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitWindow(intervalMs) {
  const startedAt = process.hrtime.bigint();
  await sleep(intervalMs);
  return Number(process.hrtime.bigint() - startedAt) / 1e9;
}

async function driveWorkloadWindow({ runner, mode, terminals, intervalMs, counters }) {
  const startedAt = process.hrtime.bigint();
  const streams = [];
  for (let paneId = 1; paneId <= terminals; paneId++) {
    streams.push(
      Promise.resolve()
        .then(() =>
          runner({
            mode,
            durationMs: intervalMs,
            cols: VIEWPORT.cols,
            rows: VIEWPORT.rows,
            paneId,
            onWrite: (chunk) => {
              counters.bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
              counters.calls += 1;
            },
          })
        )
        .catch((error) => {
          counters.errors += 1;
          console.error(`  ! workload stream ${paneId} failed: ${error.message}`);
        })
    );
  }

  await Promise.allSettled(streams);
  let elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  if (elapsedMs < intervalMs) {
    await sleep(intervalMs - elapsedMs);
    elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  }
  return elapsedMs / 1000;
}

function buildLiveSample({ scenarioId, terminalCount, elapsedSec, elapsedWindowSec, liveVisibleTerminals, snapshot, counters }) {
  const perSecond = (value) => (elapsedWindowSec > 0 ? value / elapsedWindowSec : 0);
  const { platform, ptyHost, workload, webviewSubBreakdown } = snapshot;

  return {
    timestampUnixMs: Date.now(),
    scenarioId,
    terminalCount,
    elapsedSec,
    synthetic: false,
    counterSource: 'harness',
    buckets: { platform, ptyHost, workload },
    webviewSubBreakdown: webviewSubBreakdown ?? EMPTY_WEBVIEW_BREAKDOWN(),
    dataPlane: {
      activeTerminals: terminalCount,
      liveVisibleTerminals,
      ptyBytesReadPerSec: perSecond(counters.bytes),
      vtFeedCallsPerSec: perSecond(counters.calls),
      // VT parse duration and frontend frame timing are instrumented in the app;
      // live harness runs report 0 until telemetry is replayed with --input.
      vtFeedDurationUsP95: 0,
      activityEventsEmittedPerSec: 0,
      snapshotPollsPerSec: 0,
      snapshotPayloadBytesPerSec: 0,
      dirtyRowsPaintedPerSec: 0,
      framePaintUsP50: 0,
      framePaintUsP95: 0,
      framePaintUsP99: 0,
      inputToPaintMsP95: 0,
    },
  };
}

function writeSample(outputPath, sample) {
  if (!outputPath) return;
  fs.appendFileSync(outputPath, JSON.stringify(sample) + '\n', 'utf8');
}

function logProgress(sample, sec, totalSeconds) {
  if (sec % 15 !== 0 && sec !== totalSeconds) return;
  const mode = sec <= 15 ? 'WARMUP' : 'STEADY';
  console.log(
    `  [${String(sec).padStart(2, '0')}/${totalSeconds}s | ${mode}] Platform WS: ${toMb(
      sample.buckets.platform.workingSetBytes
    )}MB, CPU: ${sample.buckets.platform.cpuPercent.toFixed(2)}%, Snapshots/s: ${sample.dataPlane.snapshotPollsPerSec.toFixed(
      1
    )}, PTY: ${(sample.dataPlane.ptyBytesReadPerSec / 1024).toFixed(1)}KB/s`
  );
}

export async function runScenario(scenarioConfig, options = {}) {
  const { id, terminals, name } = scenarioConfig;
  const totalSeconds = options.seconds || 60;
  const intervalMs = Math.max(1, options.intervalMs || 1000);
  const dryRun = options.dryRun === true;
  const samples = [];

  console.log(`\n▶ Starting Scenario: ${name} (${totalSeconds}s, ${dryRun ? 'dry-run' : 'live'})`);

  if (dryRun) {
    for (let sec = 1; sec <= totalSeconds; sec++) {
      const sample = synthesizeSample(id, sec, terminals);
      samples.push(sample);
      writeSample(options.output, sample);
      logProgress(sample, sec, totalSeconds);
    }
  } else {
    const mode = SCENARIO_WORKLOAD_MODE[id] ?? 'idle';
    const runner = options.workloadRunner ?? defaultWorkloadRunner;
    const processSampler =
      options.processSampler ?? createProcessSampler({ headlessOnly: id === 'E4-headless' });
    const liveVisibleTerminals = id === 'E4-headless' ? 0 : terminals;

    for (let sec = 1; sec <= totalSeconds; sec++) {
      const counters = { bytes: 0, calls: 0, errors: 0 };
      const elapsedWindowSec =
        mode === 'idle'
          ? await waitWindow(intervalMs)
          : await driveWorkloadWindow({
              runner,
              mode,
              terminals,
              intervalMs,
              counters,
            });
      const snapshot = await processSampler.sample();
      const sample = buildLiveSample({
        scenarioId: id,
        terminalCount: terminals,
        elapsedSec: sec,
        elapsedWindowSec,
        liveVisibleTerminals,
        snapshot,
        counters,
      });
      samples.push(sample);
      writeSample(options.output, sample);
      logProgress(sample, sec, totalSeconds);
    }

    processSampler.dispose?.();
  }

  const steadyMetrics = aggregateSteadyState(samples, 15);
  return {
    scenario: id,
    terminals,
    name,
    metrics: steadyMetrics,
    sampleCount: samples.length,
    samples,
  };
}

export function readSamplesFromJsonl(filePath) {
  const contents = fs.readFileSync(filePath, 'utf8');
  return contents
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter((entry) => entry.line.length > 0)
    .map((entry) => {
      try {
        return JSON.parse(entry.line);
      } catch {
        throw new Error(`Invalid JSONL record at line ${entry.lineNumber} of ${filePath}`);
      }
    });
}

export function resultsFromSamples(samples, args = {}) {
  const scenarioFilter = args.scenario && args.scenario !== 'all' ? args.scenario : null;
  const groups = new Map();

  for (const sample of samples) {
    if (!sample || !sample.scenarioId) continue;
    if (scenarioFilter && !(sample.scenarioId === scenarioFilter || sample.scenarioId.startsWith(scenarioFilter))) {
      continue;
    }
    const key = `${sample.scenarioId}::${sample.terminalCount}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }

  return [...groups.entries()].map(([key, groupSamples]) => {
    const [scenario, terminals] = key.split('::');
    return {
      scenario,
      terminals: Number(terminals),
      name: `${scenario} (${terminals} Terminal${Number(terminals) === 1 ? '' : 's'})`,
      metrics: aggregateSteadyState(groupSamples, 15),
      sampleCount: groupSamples.length,
      samples: groupSamples,
    };
  });
}

export async function main() {
  const args = parseArgs(process.argv);

  if (args.input) {
    const samples = readSamplesFromJsonl(args.input);
    const results = resultsFromSamples(samples, args);
    const markdown = generateMarkdownReport(results, { windowLabel: `replay of ${args.input}` });
    const reportDir = path.dirname(args.report);
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(args.report, markdown, 'utf8');

    console.log(`=======================================================`);
    console.log(`  Kite Terminal Runtime Benchmark Harness (replay)     `);
    console.log(`  Input: ${args.input} (${samples.length} samples)`);
    console.log(`  Report: ${args.report}`);
    console.log(`=======================================================`);
    console.log(markdown);
    return;
  }

  const outDir = path.dirname(args.output);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  // Clear previous output
  if (fs.existsSync(args.output)) {
    fs.unlinkSync(args.output);
  }

  const scenariosToRun = resolveScenarios(args);
  const reportDir = path.dirname(args.report);
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  console.log(`=======================================================`);
  console.log(`  Kite Terminal Runtime Benchmark Harness              `);
  console.log(`  Mode: ${args.dryRun ? 'synthetic dry-run' : 'live process & workload sampling'}`);
  console.log(`  Scenarios: ${scenariosToRun.length} | Duration: ${args.seconds}s each`);
  console.log(`  Output: ${args.output}`);
  console.log(`  Report: ${args.report}`);
  console.log(`=======================================================`);

  const results = [];
  for (const scen of scenariosToRun) {
    const res = await runScenario(scen, args);
    results.push(res);
  }

  const markdown = generateMarkdownReport(results);
  fs.writeFileSync(args.report, markdown, 'utf8');

  console.log(`\n=======================================================`);
  console.log(`✔ Benchmark Complete!`);
  console.log(`  Raw JSONL: ${args.output}`);
  console.log(`  Report Markdown: ${args.report}`);
  console.log(`=======================================================\n`);
  console.log(markdown);
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
