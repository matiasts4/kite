import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  parseArgs,
  resolveScenarios,
  classifyProcess,
  percentile,
  aggregateSteadyState,
  generateMarkdownReport,
  synthesizeSample,
  runScenario,
  defaultWorkloadRunner,
  readSamplesFromJsonl,
  resultsFromSamples,
} from './bench-terminals.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./bench-terminals.mjs', import.meta.url));
const execFileAsync = promisify(execFile);

function createFixtureSampler() {
  return {
    async sample() {
      return {
        platform: {
          processCount: 4,
          workingSetBytes: 360 * 1024 * 1024,
          privateBytes: 200 * 1024 * 1024,
          cpuPercent: 0.05,
        },
        ptyHost: {
          processCount: 2,
          workingSetBytes: 28 * 1024 * 1024,
          privateBytes: 16 * 1024 * 1024,
          cpuPercent: 0,
        },
        workload: {
          processCount: 4,
          workingSetBytes: 90 * 1024 * 1024,
          privateBytes: 48 * 1024 * 1024,
          cpuPercent: 0.1,
        },
        webviewSubBreakdown: {
          hostPrivateBytes: 68 * 1024 * 1024,
          rendererPrivateBytes: 142 * 1024 * 1024,
          gpuPrivateBytes: 45 * 1024 * 1024,
        },
      };
    },
    dispose() {},
  };
}

function createRecordingRunner(calls) {
  return async (request) => {
    calls.push(request);
    request.onWrite('A'.repeat(120));
    request.onWrite('B'.repeat(80));
  };
}

function reportMetrics(scenarioId, terminals, overrides = {}) {
  const aggregate = aggregateSteadyState([synthesizeSample(scenarioId, 30, terminals)], 0);
  return { ...aggregate, ...overrides };
}

function buildResult({ scenario, terminals, name, metrics }) {
  return {
    scenario,
    terminals,
    name: name || `${scenario} (${terminals} Terminals)`,
    metrics,
    sampleCount: metrics.sampleCount,
  };
}

test('parseArgs handles custom flags including dry-run and input', () => {
  const args = parseArgs([
    'node',
    'bench-terminals.mjs',
    '--scenario',
    'E2-spinners',
    '--terminals',
    '3',
    '--seconds',
    '30',
    '--interval-ms',
    '250',
    '--dry-run',
    '--input',
    'bench-results/samples.jsonl',
  ]);
  assert.equal(args.scenario, 'E2-spinners');
  assert.equal(args.terminals, 3);
  assert.equal(args.terminalsExplicit, true);
  assert.equal(args.seconds, 30);
  assert.equal(args.intervalMs, 250);
  assert.equal(args.dryRun, true);
  assert.equal(args.input, 'bench-results/samples.jsonl');
});

test('resolveScenarios applies an explicit --terminals override without duplicating scenarios', () => {
  const overridden = resolveScenarios(parseArgs(['node', 'bench-terminals.mjs', '--terminals', '3']));
  assert.equal(overridden.length, 5);
  assert.deepEqual(
    overridden.map((scenario) => scenario.id),
    ['E1-idle', 'E2-spinners', 'E2-logburst', 'E3-agents', 'E4-headless']
  );
  for (const scenario of overridden) {
    assert.equal(scenario.terminals, 3);
  }

  const matrix = resolveScenarios(parseArgs(['node', 'bench-terminals.mjs']));
  assert.equal(matrix.length, 9);
  assert.equal(matrix[0].terminals, 1);
});

test('classifyProcess separates platform, ptyHost, and workload without overlap', () => {
  assert.equal(classifyProcess('kite-code.exe'), 'platform');
  assert.equal(classifyProcess('msedgewebview2.exe'), 'platform');
  assert.equal(classifyProcess('conhost.exe'), 'ptyHost');
  assert.equal(classifyProcess('OpenConsole.exe'), 'ptyHost');
  assert.equal(classifyProcess('pwsh.exe'), 'workload');
  assert.equal(classifyProcess('node.exe'), 'workload');
  assert.equal(classifyProcess('cargo.exe'), 'workload');
});

test('percentile interpolates across the sample window instead of averaging', () => {
  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentile([42], 0.95), 42);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.ok(Math.abs(percentile([1, 2, 3, 4, 5], 0.99) - 4.96) < 1e-9);
});

test('synthesizeSample produces a schema-valid synthetic TerminalBenchSample', () => {
  const sample = synthesizeSample('E2-spinners', 20, 2);
  assert.equal(sample.scenarioId, 'E2-spinners');
  assert.equal(sample.terminalCount, 2);
  assert.equal(sample.elapsedSec, 20);
  assert.equal(sample.synthetic, true);
  assert.ok(sample.buckets.platform.workingSetBytes > 0);
  assert.ok(sample.buckets.ptyHost.workingSetBytes > 0);
  assert.ok(sample.buckets.workload.workingSetBytes > 0);
  assert.ok(sample.webviewSubBreakdown.rendererPrivateBytes > 0);
  assert.ok(sample.dataPlane.snapshotPollsPerSec > 0);
});

test('aggregateSteadyState discards warmup and calculates averages', () => {
  const samples = [];
  for (let sec = 1; sec <= 60; sec++) {
    samples.push(synthesizeSample('E1-idle', sec, 1));
  }
  const aggregated = aggregateSteadyState(samples, 15);
  // 60 - 15 + 1 = 46 steady state samples
  assert.equal(aggregated.sampleCount, 46);
  assert.ok(aggregated.platformWsMb > 0);
  assert.ok(aggregated.platformCpuPct < 0.2); // Idle target is < 0.2%
});

test('aggregateSteadyState computes real percentiles across the steady window', () => {
  const samples = [];
  for (let sec = 1; sec <= 40; sec++) {
    const sample = synthesizeSample('E2-spinners', sec, 2);
    sample.dataPlane.framePaintUsP50 = sec * 10;
    sample.dataPlane.framePaintUsP95 = sec * 20;
    sample.dataPlane.framePaintUsP99 = sec * 40;
    sample.dataPlane.inputToPaintMsP95 = sec;
    sample.dataPlane.vtFeedDurationUsP95 = sec * 5;
    samples.push(sample);
  }

  const aggregated = aggregateSteadyState(samples, 15);
  assert.equal(aggregated.sampleCount, 26);
  assert.equal(Math.round(aggregated.paintP50Us), 275);
  // Percentile of the steady p95 window (300..800) lands near 775; the mean would be 550.
  assert.ok(aggregated.paintP95Us > 700, `expected percentile p95, got ${aggregated.paintP95Us}`);
  assert.ok(aggregated.paintP99Us > aggregated.paintP95Us);
  assert.ok(aggregated.paintP99Us > 1500);
  assert.ok(aggregated.paintP99Us <= 1600);
  assert.ok(aggregated.vtFeedP95Us > 0);
  assert.ok(aggregated.inputToPaintP95Ms > 0);
});

test('aggregateSteadyState flags aggregates that come from synthetic samples', () => {
  const synthetic = aggregateSteadyState([synthesizeSample('E1-idle', 30, 1)], 0);
  assert.equal(synthetic.synthetic, true);

  const liveSample = { ...synthesizeSample('E1-idle', 30, 1), synthetic: false };
  const live = aggregateSteadyState([liveSample], 0);
  assert.equal(live.synthetic, false);
});

test('runScenario dry-run marks every sample synthetic and honors the terminals override', async () => {
  const result = await runScenario(
    { id: 'E2-spinners', terminals: 3, name: 'E2-spinners (3 Terminals)' },
    { seconds: 3, dryRun: true }
  );

  assert.equal(result.sampleCount, 3);
  assert.equal(result.terminals, 3);
  assert.equal(result.metrics.synthetic, true);
  assert.equal(result.samples.length, 3);
  for (const sample of result.samples) {
    assert.equal(sample.synthetic, true);
    assert.equal(sample.terminalCount, 3);
  }
});

test('runScenario live mode drives the workload generator and records measured PTY bytes', async () => {
  const calls = [];
  const result = await runScenario(
    { id: 'E2-spinners', terminals: 3, name: 'E2-spinners (3 Terminals)' },
    {
      seconds: 2,
      intervalMs: 10,
      dryRun: false,
      workloadRunner: createRecordingRunner(calls),
      processSampler: createFixtureSampler(),
    }
  );

  // One concurrent virtual stream per terminal per sample second.
  assert.equal(calls.length, 6);
  for (const request of calls) {
    assert.equal(request.mode, 'spinners');
    assert.equal(request.cols, 80);
    assert.equal(request.rows, 24);
    assert.equal(typeof request.onWrite, 'function');
    assert.ok(request.durationMs > 0);
  }

  assert.equal(result.sampleCount, 2);
  assert.equal(result.metrics.synthetic, false);
  assert.equal(result.metrics.counterSource, 'harness');
  for (const sample of result.samples) {
    assert.equal(sample.synthetic, false);
    assert.ok(sample.dataPlane.ptyBytesReadPerSec > 0);
    assert.ok(sample.dataPlane.vtFeedCallsPerSec > 0);
  }
  assert.ok(result.metrics.ptyKbReadPerSec > 0);
});

test('runScenario live mode uses the logburst workload for E2-logburst', async () => {
  const calls = [];
  await runScenario(
    { id: 'E2-logburst', terminals: 2, name: 'E2-logburst (2 Terminals)' },
    {
      seconds: 1,
      intervalMs: 10,
      dryRun: false,
      workloadRunner: createRecordingRunner(calls),
      processSampler: createFixtureSampler(),
    }
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].mode, 'logburst');
  assert.equal(calls[1].mode, 'logburst');
});

test('runScenario live idle mode samples without driving any workload output', async () => {
  const calls = [];
  const result = await runScenario(
    { id: 'E1-idle', terminals: 2, name: 'E1-idle (2 Terminals)' },
    {
      seconds: 1,
      intervalMs: 10,
      dryRun: false,
      workloadRunner: createRecordingRunner(calls),
      processSampler: createFixtureSampler(),
    }
  );

  assert.equal(calls.length, 0);
  assert.equal(result.samples[0].dataPlane.ptyBytesReadPerSec, 0);
  assert.equal(result.samples[0].buckets.platform.processCount, 4);
});

test('defaultWorkloadRunner streams deterministic generator bytes', async () => {
  let bytes = 0;
  let calls = 0;
  await defaultWorkloadRunner({
    mode: 'spinners',
    durationMs: 1000,
    cols: 80,
    rows: 24,
    paneId: 1,
    onWrite: (chunk) => {
      bytes += Buffer.byteLength(chunk);
      calls += 1;
    },
  });

  assert.ok(bytes > 1000, `expected generator bytes, got ${bytes}`);
  assert.ok(calls > 5, `expected multiple VT feed chunks, got ${calls}`);
});

test('generateMarkdownReport marks synthetic runs with a dry-run banner', () => {
  const results = [
    buildResult({
      scenario: 'E1-idle',
      terminals: 2,
      metrics: reportMetrics('E1-idle', 2),
    }),
  ];
  const report = generateMarkdownReport(results);
  assert.ok(
    report.includes(
      '> ⚠️ **Mode: Synthetic Dry-Run** — Values below are simulated for harness verification and do not represent live hardware measurements.'
    )
  );
});

test('generateMarkdownReport omits the dry-run banner for live samples', () => {
  const results = [
    buildResult({
      scenario: 'E1-idle',
      terminals: 2,
      metrics: reportMetrics('E1-idle', 2, { synthetic: false, platformProcessCount: 4 }),
    }),
  ];
  const report = generateMarkdownReport(results);
  assert.equal(report.includes('Synthetic Dry-Run'), false);
});

test('generateMarkdownReport reports FAIL when E1 idle CPU exceeds the 0.2% target', () => {
  const results = [
    buildResult({
      scenario: 'E1-idle',
      terminals: 1,
      name: 'E1-idle (1 Terminal)',
      metrics: reportMetrics('E1-idle', 1, { platformCpuPct: 0.35, snapshotPollsPerSec: 0 }),
    }),
  ];
  const report = generateMarkdownReport(results);
  assert.match(report, /Bucket A CPU \*\*0\.35%\*\* \(target < 0\.2%\) → \*\*FAIL\*\*/);
  assert.match(report, /snapshot polls \*\*0\.0\/s\*\* \(target 0\/s\) → \*\*PASS\*\*/);
});

test('generateMarkdownReport reports FAIL when E4 headless working set exceeds 45 MB', () => {
  const results = [
    buildResult({
      scenario: 'E4-headless',
      terminals: 2,
      name: 'E4-headless (2 Agents Persistence)',
      metrics: reportMetrics('E4-headless', 2, { synthetic: false, platformWsMb: 46.2 }),
    }),
  ];
  const report = generateMarkdownReport(results);
  assert.match(report, /Bucket A Working Set \*\*46\.2 MB\*\* \(target < 45 MB\) → \*\*FAIL\*\*/);
});

test('generateMarkdownReport reports PASS when E4 headless working set stays under 45 MB', () => {
  const results = [
    buildResult({
      scenario: 'E4-headless',
      terminals: 2,
      metrics: reportMetrics('E4-headless', 2, { synthetic: false, platformWsMb: 42 }),
    }),
  ];
  const report = generateMarkdownReport(results);
  assert.match(report, /Bucket A Working Set \*\*42\.0 MB\*\* \(target < 45 MB\) → \*\*PASS\*\*/);
});

test('generateMarkdownReport reports FAIL when E2 snapshots exceed 30 Hz per pane', () => {
  const results = [
    buildResult({
      scenario: 'E2-spinners',
      terminals: 2,
      name: 'E2-spinners (2 Terminals)',
      metrics: reportMetrics('E2-spinners', 2, { synthetic: false, snapshotPollsPerSec: 90 }),
    }),
  ];
  const report = generateMarkdownReport(results);
  assert.match(
    report,
    /snapshot polls \*\*90\.0\/s\*\* \(target ≤ 60\/s = 30 Hz × 2 panes\) → \*\*FAIL\*\*/
  );
});

test('generateMarkdownReport never claims PASS for IPC counters a live harness cannot observe', () => {
  const results = [
    buildResult({
      scenario: 'E2-spinners',
      terminals: 2,
      name: 'E2-spinners (2 Terminals)',
      metrics: reportMetrics('E2-spinners', 2, {
        synthetic: false,
        counterSource: 'harness',
        snapshotPollsPerSec: 0,
      }),
    }),
  ];
  const report = generateMarkdownReport(results);
  assert.match(report, /snapshot polls \*\*not measured\*\*/);
  assert.equal(report.includes('= 30 Hz × 2 panes) → **PASS**'), false);
});

test('generateMarkdownReport produces Markdown table with target columns', () => {
  const sample = synthesizeSample('E1-idle', 30, 2);
  const metrics = aggregateSteadyState([sample], 0);
  const report = generateMarkdownReport([
    {
      scenario: 'E1-idle',
      terminals: 2,
      name: 'E1-idle (2 Terminals)',
      metrics,
      sampleCount: 1,
    },
  ]);
  assert.ok(report.includes('| Scenario | Terminals | Bucket A WS (MB)'));
  assert.ok(report.includes('| **E1-idle** | 2 |'));
  assert.ok(report.includes('Bucket A (Platform Overhead)'));
});

test('readSamplesFromJsonl parses records and fails with the offending line number', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-bench-jsonl-'));
  try {
    const file = path.join(dir, 'samples.jsonl');
    const line = JSON.stringify(synthesizeSample('E2-spinners', 20, 2));
    fs.writeFileSync(file, `${line}\n${line}\n`, 'utf8');
    const samples = readSamplesFromJsonl(file);
    assert.equal(samples.length, 2);
    assert.equal(samples[1].scenarioId, 'E2-spinners');

    fs.writeFileSync(file, `${line}\nnot-json\n`, 'utf8');
    assert.throws(() => readSamplesFromJsonl(file), /line 2/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resultsFromSamples groups captured telemetry by scenario and terminal count', () => {
  const samples = [
    synthesizeSample('E1-idle', 20, 1),
    synthesizeSample('E1-idle', 21, 1),
    { ...synthesizeSample('E2-spinners', 20, 2), synthetic: false },
  ];
  const results = resultsFromSamples(samples, { scenario: 'all' });
  assert.equal(results.length, 2);

  const idle = results.find((result) => result.scenario === 'E1-idle');
  assert.equal(idle.terminals, 1);
  assert.equal(idle.metrics.sampleCount, 2);
  assert.equal(idle.metrics.synthetic, true);

  const streaming = results.find((result) => result.scenario === 'E2-spinners');
  assert.equal(streaming.terminals, 2);
  assert.equal(streaming.metrics.synthetic, false);

  const filtered = resultsFromSamples(samples, { scenario: 'E2-spinners' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].scenario, 'E2-spinners');
});

test('CLI dry-run honors --terminals and writes synthetic JSONL plus report', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-bench-cli-'));
  try {
    const output = path.join(dir, 'samples.jsonl');
    const report = path.join(dir, 'summary.md');
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        SCRIPT_PATH,
        '--scenario',
        'E1-idle',
        '--dry-run',
        '--seconds',
        '3',
        '--terminals',
        '3',
        '--output',
        output,
        '--report',
        report,
      ],
      { cwd: path.dirname(SCRIPT_PATH), timeout: 60000 }
    );

    const records = fs
      .readFileSync(output, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 3);
    for (const record of records) {
      assert.equal(record.terminalCount, 3);
      assert.equal(record.synthetic, true);
    }

    const markdown = fs.readFileSync(report, 'utf8');
    assert.ok(markdown.includes('Synthetic Dry-Run'));
    assert.ok(markdown.includes('| **E1-idle** | 3 |'));
    assert.ok(stdout.includes('Synthetic Dry-Run'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
