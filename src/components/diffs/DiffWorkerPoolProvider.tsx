import { useEffect, useState, type ReactNode } from 'react';
import { WorkerPoolContext, useWorkerPool } from '@pierre/diffs/react';
import {
  getOrCreateWorkerPoolSingleton,
  terminateWorkerPoolSingleton,
  type WorkerPoolManager,
} from '@pierre/diffs/worker';
import DiffWorker from '@pierre/diffs/worker/worker.js?worker';
import {
  ensureReadableLightDiffTheme,
  KITE_DIFF_THEMES,
} from '../../lib/diffs/readableSyntaxTheme';
import { PREFERRED_DIFF_HIGHLIGHTER } from '../../lib/diffs/syntaxHighlighting';

export const DIFF_WORKER_IDLE_DISPOSE_MS = 60_000;

let activeConsumers = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let sharedPool: WorkerPoolManager | null = null;

function canUseWorkers(): boolean {
  return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

function getDocumentVisible(): boolean {
  if (typeof document === 'undefined') return true;
  return !document.hidden && document.visibilityState !== 'hidden';
}

function createDiffWorkerPoolSize(): number {
  if (typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number') {
    return Math.max(1, Math.min(2, Math.floor(navigator.hardwareConcurrency / 2) || 2));
  }
  return 2;
}

const POOL_RENDER_OPTIONS = {
  theme: KITE_DIFF_THEMES,
  preferredHighlighter: PREFERRED_DIFF_HIGHLIGHTER,
  lineDiffType: 'word-alt' as const,
};

function clearIdleDisposeTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function acquireSharedWorkerPool(): WorkerPoolManager | undefined {
  if (!canUseWorkers()) return undefined;
  clearIdleDisposeTimer();
  ensureReadableLightDiffTheme();
  if (!sharedPool) {
    sharedPool = getOrCreateWorkerPoolSingleton({
      poolOptions: {
        workerFactory: () => new DiffWorker(),
        poolSize: createDiffWorkerPoolSize(),
        mainThreadMaxCharacters: 12_000,
      },
      highlighterOptions: POOL_RENDER_OPTIONS,
    });
  }
  return sharedPool;
}

function releaseSharedWorkerPool(): void {
  activeConsumers = Math.max(0, activeConsumers - 1);
  if (activeConsumers === 0 && sharedPool) {
    clearIdleDisposeTimer();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (activeConsumers === 0 && sharedPool) {
        sharedPool = null;
        terminateWorkerPoolSingleton();
      }
    }, DIFF_WORKER_IDLE_DISPOSE_MS);
  }
}

export function __resetDiffWorkerPoolForTests(): void {
  clearIdleDisposeTimer();
  activeConsumers = 0;
  if (sharedPool) {
    sharedPool = null;
    terminateWorkerPoolSingleton();
  }
}

/**
 * Provides a shared, ref-counted `@pierre/diffs` syntax-highlighting WorkerPool
 * capped at 1–2 workers when running in browser/Tauri environments, and disposes
 * idle workers after 60s of inactivity once all consumers unmount or go hidden.
 */
export function DiffWorkerPoolProvider({
  children,
  active = true,
}: {
  children: ReactNode;
  active?: boolean;
}) {
  const existingPool = useWorkerPool();
  const [docVisible, setDocVisible] = useState<boolean>(() => getDocumentVisible());

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handleVisibility = () => {
      setDocVisible(getDocumentVisible());
    };
    handleVisibility();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  const isEffectivelyActive = active && docVisible;
  const [poolManager, setPoolManager] = useState<WorkerPoolManager | undefined>(() => {
    if (existingPool || !isEffectivelyActive) return undefined;
    return acquireSharedWorkerPool();
  });

  const activePool =
    !existingPool && isEffectivelyActive
      ? (poolManager ?? acquireSharedWorkerPool())
      : undefined;

  useEffect(() => {
    if (existingPool || !isEffectivelyActive) {
      setPoolManager(undefined);
      return;
    }
    const acquired = acquireSharedWorkerPool();
    setPoolManager((prev) => (prev === acquired ? prev : acquired));
    if (!acquired) return;
    activeConsumers += 1;
    clearIdleDisposeTimer();
    return () => {
      releaseSharedWorkerPool();
    };
  }, [existingPool, isEffectivelyActive]);

  if (existingPool || !activePool) {
    return <>{children}</>;
  }

  return (
    <WorkerPoolContext.Provider value={activePool}>
      {children}
    </WorkerPoolContext.Provider>
  );
}
