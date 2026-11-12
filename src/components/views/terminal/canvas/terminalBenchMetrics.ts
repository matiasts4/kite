import { invokeCommand, isTauriEnvironment } from '../../../../lib/ipc';

export interface FrontendBenchMetrics {
  dirtyRowsPaintedPerSec: number;
  framePaintUsP50: number;
  framePaintUsP95: number;
  framePaintUsP99: number;
  inputToPaintMsP95: number;
}

declare global {
  interface Window {
    __KITE_BENCHMARK_ACTIVE__?: boolean;
    __KITE_BENCHMARK__?: {
      isActive: () => boolean;
      setActive: (active: boolean) => void;
      getMetrics: (options?: { reset?: boolean }) => FrontendBenchMetrics;
      flush: () => FrontendBenchMetrics;
      reset: () => void;
      recordInput: (ts?: number) => void;
      recordFramePaint: (durationUs: number, rowsCount: number) => void;
    };
  }
}

const MAX_SAMPLES = 2048;
const paintDurationsUs: number[] = [];
const inputLatenciesMs: number[] = [];
let totalDirtyRowsPainted = 0;
let lastMetricsSampleTime = typeof performance !== 'undefined' ? performance.now() : 0;
let lastDirtyRowsBaseline = 0;
let pendingInputTimestamp: number | null = null;
let benchmarkActive = false;
let autoReportInterval: number | null = null;

export function isTerminalBenchmarkActive(): boolean {
  if (benchmarkActive) return true;
  if (typeof window !== 'undefined' && Boolean(window.__KITE_BENCHMARK_ACTIVE__)) {
    return true;
  }
  return false;
}

export function setTerminalBenchmarkActive(active: boolean): void {
  benchmarkActive = active;
  if (typeof window !== 'undefined') {
    window.__KITE_BENCHMARK_ACTIVE__ = active;
  }
  if (active) {
    startAutoReporting();
  } else {
    stopAutoReporting();
  }
}

export function recordTerminalUserInput(timestamp?: number): void {
  if (!isTerminalBenchmarkActive()) return;
  pendingInputTimestamp = timestamp ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
}

export function recordFramePaint(durationUs: number, dirtyRowsCount: number): void {
  if (!isTerminalBenchmarkActive()) return;

  totalDirtyRowsPainted += dirtyRowsCount;

  if (paintDurationsUs.length >= MAX_SAMPLES) {
    paintDurationsUs.splice(0, MAX_SAMPLES / 2);
  }
  paintDurationsUs.push(durationUs);

  if (pendingInputTimestamp !== null) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const latency = Math.max(0, now - pendingInputTimestamp);
    pendingInputTimestamp = null;

    if (inputLatenciesMs.length >= MAX_SAMPLES) {
      inputLatenciesMs.splice(0, MAX_SAMPLES / 2);
    }
    inputLatenciesMs.push(latency);
  }
}

function calculatePercentile(samples: number[], percentile: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length * percentile) / 100))
  );
  return Math.round(sorted[index] * 100) / 100;
}

export function getFrontendBenchMetrics(options?: { reset?: boolean }): FrontendBenchMetrics {
  return options?.reset ? flushFrontendBenchMetrics() : peekFrontendBenchMetrics();
}

/**
 * Reads the current window without consuming it. External inspection (harness,
 * window bridge, devtools) must not wipe the active 1-second dirty-row window.
 */
export function peekFrontendBenchMetrics(): FrontendBenchMetrics {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const elapsedSec = Math.max(0.001, (now - lastMetricsSampleTime) / 1000);
  const dirtyRowsDiff = totalDirtyRowsPainted - lastDirtyRowsBaseline;

  return {
    dirtyRowsPaintedPerSec: Math.round(dirtyRowsDiff / elapsedSec),
    framePaintUsP50: calculatePercentile(paintDurationsUs, 50),
    framePaintUsP95: calculatePercentile(paintDurationsUs, 95),
    framePaintUsP99: calculatePercentile(paintDurationsUs, 99),
    inputToPaintMsP95: calculatePercentile(inputLatenciesMs, 95),
  };
}

/**
 * Reports the completed window and resets it so the next second starts clean.
 * Only the 1 Hz reporter calls this; per-frame callers would collapse the
 * dirty-row window to a single frame interval.
 */
export function flushFrontendBenchMetrics(): FrontendBenchMetrics {
  const metrics = peekFrontendBenchMetrics();
  lastMetricsSampleTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
  lastDirtyRowsBaseline = totalDirtyRowsPainted;
  return metrics;
}

export function resetBenchmarkMetrics(): void {
  paintDurationsUs.length = 0;
  inputLatenciesMs.length = 0;
  totalDirtyRowsPainted = 0;
  lastDirtyRowsBaseline = 0;
  pendingInputTimestamp = null;
  lastMetricsSampleTime = typeof performance !== 'undefined' ? performance.now() : 0;
}

export function reportMetricsToBackend(): void {
  if (!isTauriEnvironment()) return;
  // Flush once per second: the reported rate covers the elapsed window and the
  // baseline resets for the next one.
  const metrics = flushFrontendBenchMetrics();
  void invokeCommand('report_terminal_frontend_metrics', { metrics }).catch(() => {});
}

function startAutoReporting(): void {
  if (autoReportInterval !== null) return;
  if (typeof window === 'undefined') return;
  autoReportInterval = window.setInterval(() => {
    if (!isTerminalBenchmarkActive()) {
      stopAutoReporting();
      return;
    }
    reportMetricsToBackend();
  }, 1000);
}

function stopAutoReporting(): void {
  if (autoReportInterval !== null) {
    if (typeof window !== 'undefined') {
      window.clearInterval(autoReportInterval);
    }
    autoReportInterval = null;
  }
}

// Attach to window for programmatic test / benchmark harness automation
if (typeof window !== 'undefined') {
  window.__KITE_BENCHMARK__ = {
    isActive: isTerminalBenchmarkActive,
    setActive: setTerminalBenchmarkActive,
    getMetrics: getFrontendBenchMetrics,
    flush: flushFrontendBenchMetrics,
    reset: resetBenchmarkMetrics,
    recordInput: recordTerminalUserInput,
    recordFramePaint,
  };
}
