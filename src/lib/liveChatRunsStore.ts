import { invokeCommand } from './ipc';
import type { LiveChatRun } from '../components/views/chat/types';

export type SharedLiveChatRun = LiveChatRun & {
  agentId?: string;
  status?: string;
};

const POLL_INTERVAL_MS = 4000;
const DEDUP_WINDOW_MS = 1500;
const FETCH_TIMEOUT_MS = 5000;

type Listener = (runs: SharedLiveChatRun[]) => void;

const listeners = new Set<Listener>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<SharedLiveChatRun[] | null> | null = null;
let lastRuns: SharedLiveChatRun[] | null = null;
let lastFetchedAt = 0;
let storeGeneration = 0;

export function areLiveChatRunsEqual(
  a: readonly SharedLiveChatRun[],
  b: readonly SharedLiveChatRun[]
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const ar = a[i];
    const br = b[i];
    if (
      ar.runId !== br.runId ||
      ar.threadId !== br.threadId ||
      ar.nextSequence !== br.nextSequence ||
      ar.profileId !== br.profileId ||
      ar.agentId !== br.agentId ||
      ar.status !== br.status ||
      ar.needsYou !== br.needsYou
    ) {
      return false;
    }
  }
  return true;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('list_live_chat_runs timed out')), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export function isLiveChatRunsFetchInFlight(): boolean {
  return inflight !== null;
}

export async function fetchSharedLiveChatRuns(force = false): Promise<SharedLiveChatRun[] | null> {
  const now = Date.now();
  if (!force && lastRuns !== null && now - lastFetchedAt < DEDUP_WINDOW_MS) {
    return lastRuns;
  }
  if (inflight) {
    return inflight;
  }

  const gen = storeGeneration;
  inflight = withTimeout(
    invokeCommand<SharedLiveChatRun[]>('list_live_chat_runs'),
    FETCH_TIMEOUT_MS
  )
    .then((runs) => {
      if (gen !== storeGeneration || !Array.isArray(runs)) return null;
      lastFetchedAt = Date.now();
      const changed = lastRuns === null || !areLiveChatRunsEqual(lastRuns, runs);
      if (changed) {
        lastRuns = runs;
      }
      const next = lastRuns ?? runs;
      for (const listener of listeners) {
        listener(next);
      }
      return next;
    })
    .catch(() => null)
    .finally(() => {
      if (gen === storeGeneration) {
        inflight = null;
      }
    });

  return inflight;
}

function ensurePoller() {
  if (pollTimer !== null || listeners.size === 0) return;
  pollTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    void fetchSharedLiveChatRuns(false);
  }, POLL_INTERVAL_MS);
}

function stopPollerIfUnused() {
  if (listeners.size > 0) return;
  storeGeneration += 1;
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  inflight = null;
  lastRuns = null;
  lastFetchedAt = 0;
}

export function subscribeLiveChatRuns(
  listener: Listener,
  options?: { immediate?: boolean }
): () => void {
  listeners.add(listener);
  ensurePoller();
  if (options?.immediate) {
    void fetchSharedLiveChatRuns(false);
  }
  return () => {
    listeners.delete(listener);
    stopPollerIfUnused();
  };
}

export function resetLiveChatRunsStoreForTest(): void {
  listeners.clear();
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  inflight = null;
  lastRuns = null;
  lastFetchedAt = 0;
}
