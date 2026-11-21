import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useWorkerPool } from '@pierre/diffs/react';
import type { WorkerPoolManager } from '@pierre/diffs/worker';

const { mockGetOrCreate, mockTerminate, createdPools } = vi.hoisted(() => {
  const createdPools: Array<{ id: number; terminate: ReturnType<typeof vi.fn>; poolSize: number }> = [];
  let nextId = 1;
  let activeSingleton: (typeof createdPools)[number] | undefined;

  const mockGetOrCreate = vi.fn((args: { poolOptions: { poolSize?: number } }) => {
    if (!activeSingleton) {
      activeSingleton = {
        id: nextId++,
        terminate: vi.fn(),
        poolSize: args.poolOptions.poolSize ?? 0,
      };
      createdPools.push(activeSingleton);
    }
    return activeSingleton as unknown as WorkerPoolManager;
  });

  const mockTerminate = vi.fn(() => {
    if (activeSingleton) {
      activeSingleton.terminate();
      activeSingleton = undefined;
    }
  });

  return { mockGetOrCreate, mockTerminate, createdPools };
});

vi.mock('@pierre/diffs/worker/worker.js?worker', () => ({
  default: class MockDiffWorker {},
}));

vi.mock('@pierre/diffs/worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pierre/diffs/worker')>();
  return {
    ...actual,
    getOrCreateWorkerPoolSingleton: mockGetOrCreate,
    terminateWorkerPoolSingleton: mockTerminate,
  };
});

vi.mock('../../lib/diffs/readableSyntaxTheme', () => ({
  ensureReadableLightDiffTheme: vi.fn(),
  KITE_DIFF_THEMES: { dark: 'pierre-dark', light: 'kite-light' },
}));

import {
  DiffWorkerPoolProvider,
  DIFF_WORKER_IDLE_DISPOSE_MS,
  __resetDiffWorkerPoolForTests,
} from './DiffWorkerPoolProvider';

function PoolConsumer({ onPool }: { onPool: (pool: WorkerPoolManager | undefined) => void }) {
  const pool = useWorkerPool();
  onPool(pool);
  return <div data-testid="pool-consumer" />;
}

describe('DiffWorkerPoolProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', class MockWorker {});
    vi.stubGlobal('navigator', { hardwareConcurrency: 16 });
    mockGetOrCreate.mockClear();
    mockTerminate.mockClear();
    createdPools.length = 0;
    __resetDiffWorkerPoolForTests?.();
  });

  afterEach(() => {
    __resetDiffWorkerPoolForTests?.();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shares one singleton worker pool capped at <= 2 workers across multiple mounted consumers', () => {
    const seenA: Array<WorkerPoolManager | undefined> = [];
    const seenB: Array<WorkerPoolManager | undefined> = [];
    const seenC: Array<WorkerPoolManager | undefined> = [];

    render(
      <>
        <DiffWorkerPoolProvider>
          <PoolConsumer onPool={(p) => seenA.push(p)} />
        </DiffWorkerPoolProvider>
        <DiffWorkerPoolProvider>
          <PoolConsumer onPool={(p) => seenB.push(p)} />
        </DiffWorkerPoolProvider>
        <DiffWorkerPoolProvider>
          <PoolConsumer onPool={(p) => seenC.push(p)} />
        </DiffWorkerPoolProvider>
      </>
    );

    expect(mockGetOrCreate).toHaveBeenCalledTimes(1);
    const poolOptions = mockGetOrCreate.mock.calls[0][0].poolOptions;
    expect(poolOptions.poolSize).toBeGreaterThanOrEqual(1);
    expect(poolOptions.poolSize).toBeLessThanOrEqual(2);

    expect(seenA[seenA.length - 1]).toBeDefined();
    expect(seenA[seenA.length - 1]).toBe(seenB[seenB.length - 1]);
    expect(seenB[seenB.length - 1]).toBe(seenC[seenC.length - 1]);
  });

  it('terminates idle workers only after all consumers unmount and idle timeout elapses', () => {
    const view1 = render(
      <DiffWorkerPoolProvider>
        <PoolConsumer onPool={() => {}} />
      </DiffWorkerPoolProvider>
    );
    const view2 = render(
      <DiffWorkerPoolProvider>
        <PoolConsumer onPool={() => {}} />
      </DiffWorkerPoolProvider>
    );

    expect(mockGetOrCreate).toHaveBeenCalledTimes(1);

    // Unmount first consumer while second is still active
    view1.unmount();
    act(() => {
      vi.advanceTimersByTime(DIFF_WORKER_IDLE_DISPOSE_MS + 5_000);
    });
    expect(mockTerminate).not.toHaveBeenCalled();

    // Unmount last consumer -> idle timer starts, not terminated immediately
    view2.unmount();
    expect(mockTerminate).not.toHaveBeenCalled();

    // Advance just before idle timeout
    act(() => {
      vi.advanceTimersByTime(DIFF_WORKER_IDLE_DISPOSE_MS - 1_000);
    });
    expect(mockTerminate).not.toHaveBeenCalled();

    // Cross idle timeout -> pool is terminated
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(mockTerminate).toHaveBeenCalledTimes(1);
  });

  it('cancels pending idle termination if a new consumer mounts before timeout', () => {
    const view1 = render(
      <DiffWorkerPoolProvider>
        <PoolConsumer onPool={() => {}} />
      </DiffWorkerPoolProvider>
    );
    view1.unmount();

    act(() => {
      vi.advanceTimersByTime(DIFF_WORKER_IDLE_DISPOSE_MS / 2);
    });
    expect(mockTerminate).not.toHaveBeenCalled();

    const view2 = render(
      <DiffWorkerPoolProvider>
        <PoolConsumer onPool={() => {}} />
      </DiffWorkerPoolProvider>
    );

    act(() => {
      vi.advanceTimersByTime(DIFF_WORKER_IDLE_DISPOSE_MS);
    });
    expect(mockTerminate).not.toHaveBeenCalled();
    expect(mockGetOrCreate).toHaveBeenCalledTimes(1);

    view2.unmount();
    act(() => {
      vi.advanceTimersByTime(DIFF_WORKER_IDLE_DISPOSE_MS);
    });
    expect(mockTerminate).toHaveBeenCalledTimes(1);
  });
});
