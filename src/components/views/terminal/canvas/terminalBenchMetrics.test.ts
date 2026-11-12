import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../../lib/ipc', () => ({
  invokeCommand: vi.fn(() => Promise.resolve({ ok: true })),
  isTauriEnvironment: () => true,
}));

import { invokeCommand } from '../../../../lib/ipc';
import {
  isTerminalBenchmarkActive,
  setTerminalBenchmarkActive,
  recordTerminalUserInput,
  recordFramePaint,
  getFrontendBenchMetrics,
  peekFrontendBenchMetrics,
  flushFrontendBenchMetrics,
  resetBenchmarkMetrics,
} from './terminalBenchMetrics';

describe('terminalBenchMetrics', () => {
  beforeEach(() => {
    resetBenchmarkMetrics();
    setTerminalBenchmarkActive(false);
    vi.mocked(invokeCommand).mockClear();
  });

  afterEach(() => {
    setTerminalBenchmarkActive(false);
    vi.useRealTimers();
  });

  it('is inactive by default', () => {
    expect(isTerminalBenchmarkActive()).toBe(false);
  });

  it('can be enabled and disabled', () => {
    setTerminalBenchmarkActive(true);
    expect(isTerminalBenchmarkActive()).toBe(true);
    setTerminalBenchmarkActive(false);
    expect(isTerminalBenchmarkActive()).toBe(false);
  });

  it('ignores samples while inactive', () => {
    setTerminalBenchmarkActive(false);
    recordFramePaint(1200, 5);

    const metrics = flushFrontendBenchMetrics();
    expect(metrics.framePaintUsP50).toBe(0);
    expect(metrics.dirtyRowsPaintedPerSec).toBe(0);
  });

  it('computes frame paint latency percentiles and dirty row counts', () => {
    setTerminalBenchmarkActive(true);

    // Record sample paint durations (in microseconds)
    for (let i = 1; i <= 100; i++) {
      recordFramePaint(i * 100, 2); // 100us, 200us, ..., 10000us
    }

    const metrics = getFrontendBenchMetrics();
    expect(metrics.framePaintUsP50).toBeGreaterThanOrEqual(4900);
    expect(metrics.framePaintUsP50).toBeLessThanOrEqual(5100);
    expect(metrics.framePaintUsP95).toBeGreaterThanOrEqual(9400);
    expect(metrics.framePaintUsP95).toBeLessThanOrEqual(9600);
    expect(metrics.framePaintUsP99).toBeGreaterThanOrEqual(9800);
    expect(metrics.dirtyRowsPaintedPerSec).toBeGreaterThan(0);
  });

  it('records input to paint latency', () => {
    setTerminalBenchmarkActive(true);

    recordTerminalUserInput(1000);
    // Simulate frame paint completing 16ms later
    recordFramePaint(500, 1);

    const metrics = getFrontendBenchMetrics();
    expect(metrics.inputToPaintMsP95).toBeGreaterThan(0);
  });

  it('does not consume the dirty-row window when metrics are inspected', () => {
    setTerminalBenchmarkActive(true);
    recordFramePaint(500, 10);

    const first = getFrontendBenchMetrics();
    const second = getFrontendBenchMetrics();

    expect(first.dirtyRowsPaintedPerSec).toBeGreaterThan(0);
    expect(second.dirtyRowsPaintedPerSec).toBeGreaterThan(0);
    expect(second.framePaintUsP50).toBe(first.framePaintUsP50);
  });

  it('keeps window.__KITE_BENCHMARK__.getMetrics() non-destructive', () => {
    setTerminalBenchmarkActive(true);
    recordFramePaint(500, 10);

    const first = window.__KITE_BENCHMARK__?.getMetrics();
    const second = window.__KITE_BENCHMARK__?.getMetrics();

    expect(first?.dirtyRowsPaintedPerSec).toBeGreaterThan(0);
    expect(second?.dirtyRowsPaintedPerSec).toBeGreaterThan(0);
  });

  it('flushFrontendBenchMetrics reports the window and resets it', () => {
    setTerminalBenchmarkActive(true);
    recordFramePaint(1000, 7);

    const flushed = flushFrontendBenchMetrics();
    expect(flushed.dirtyRowsPaintedPerSec).toBeGreaterThan(0);

    const afterFlush = peekFrontendBenchMetrics();
    expect(afterFlush.dirtyRowsPaintedPerSec).toBe(0);
    expect(afterFlush.framePaintUsP50).toBe(1000);
  });

  it('flushes when getFrontendBenchMetrics({ reset: true }) is requested', () => {
    setTerminalBenchmarkActive(true);
    recordFramePaint(1000, 7);

    const flushed = getFrontendBenchMetrics({ reset: true });
    expect(flushed.dirtyRowsPaintedPerSec).toBeGreaterThan(0);

    const afterFlush = getFrontendBenchMetrics();
    expect(afterFlush.dirtyRowsPaintedPerSec).toBe(0);
  });

  it('reports once per second and resets the window for the next second', async () => {
    vi.useFakeTimers();
    setTerminalBenchmarkActive(true);
    recordFramePaint(1000, 4);

    await vi.advanceTimersByTimeAsync(1000);

    expect(invokeCommand).toHaveBeenCalledTimes(1);
    const [command, args] = vi.mocked(invokeCommand).mock.calls[0];
    expect(command).toBe('report_terminal_frontend_metrics');
    const firstMetrics = (args as { metrics: { dirtyRowsPaintedPerSec: number } }).metrics;
    expect(firstMetrics.dirtyRowsPaintedPerSec).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(1000);

    expect(invokeCommand).toHaveBeenCalledTimes(2);
    const secondArgs = vi.mocked(invokeCommand).mock.calls[1][1] as {
      metrics: { dirtyRowsPaintedPerSec: number };
    };
    expect(secondArgs.metrics.dirtyRowsPaintedPerSec).toBe(0);
  });

  it('resets metrics cleanly', () => {
    setTerminalBenchmarkActive(true);
    recordFramePaint(1200, 5);
    resetBenchmarkMetrics();
    const metrics = getFrontendBenchMetrics();
    expect(metrics.framePaintUsP50).toBe(0);
    expect(metrics.inputToPaintMsP95).toBe(0);
  });
});
