import { useEffect, useMemo, type ReactNode } from 'react';
import { WorkerPoolContextProvider, useWorkerPool } from '@pierre/diffs/react';
import DiffWorker from '@pierre/diffs/worker/worker.js?worker';
import {
  ensureReadableLightDiffTheme,
  KITE_DIFF_THEMES,
} from '../../lib/diffs/readableSyntaxTheme';
import { PREFERRED_DIFF_HIGHLIGHTER } from '../../lib/diffs/syntaxHighlighting';

function canUseWorkers(): boolean {
  return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

function createDiffWorkerPoolSize(): number {
  if (typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number') {
    return Math.max(1, Math.min(4, Math.floor(navigator.hardwareConcurrency / 2) || 2));
  }
  return 2;
}

const POOL_RENDER_OPTIONS = {
  theme: KITE_DIFF_THEMES,
  preferredHighlighter: PREFERRED_DIFF_HIGHLIGHTER,
  lineDiffType: 'word-alt' as const,
};

/**
 * Provides a shared `@pierre/diffs` syntax-highlighting WorkerPool when running
 * in browser/Tauri environments, and renders children directly in headless/test
 * environments without Web Worker support.
 */
export function DiffWorkerPoolProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    ensureReadableLightDiffTheme();
  }, []);

  const existingPool = useWorkerPool();
  const poolOptions = useMemo(() => {
    if (!canUseWorkers() || existingPool) return null;
    ensureReadableLightDiffTheme();
    return {
      workerFactory: () => new DiffWorker(),
      poolSize: createDiffWorkerPoolSize(),
      mainThreadMaxCharacters: 12_000,
    };
  }, [existingPool]);

  if (existingPool || !poolOptions) {
    return <>{children}</>;
  }

  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={POOL_RENDER_OPTIONS}>
      {children}
    </WorkerPoolContextProvider>
  );
}
