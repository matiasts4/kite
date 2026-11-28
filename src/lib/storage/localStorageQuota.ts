export const CHAT_THREAD_CACHE_PREFIX = 'kite.chat.thread.';
export const CHAT_GRID_KEY = 'kite.chat.grid.v1';
export const CHAT_SUMMARIES_KEY = 'kite.chat.summaries.v1';
export const LEGACY_OVERSIZED_THREAD_CACHE_CHARS = 200_000;
export const AGGRESSIVE_OVERSIZED_THREAD_CACHE_CHARS = 150_000;
export const MAX_RETAINED_THREAD_CACHE_ENTRIES = 8;
export const REGENERABLE_CACHE_KEYS = [
  'bmone.cached_agents',
  'kite_quota_cache',
  'kite_quotas_tab_swr_v1',
  'kite.cached_agents',
  'kite.cached_workspaces',
] as const;

export interface ReclaimLocalStorageOptions {
  aggressive?: boolean;
  storage?: Storage;
  retryWrite?: () => void;
}

export interface ReclaimLocalStorageResult {
  removedKeys: string[];
  freedChars: number;
  writeSucceeded: boolean;
}

interface ThreadCacheEntry {
  key: string;
  threadId: string;
  size: number;
}

function snapshotStorageKeys(storage: Storage): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key !== null) {
        keys.push(key);
      }
    }
  } catch {
    // Ignore storage enumeration errors
  }
  return keys;
}

function readProtectedGridThreadIds(storage: Storage): Set<string> {
  const protectedIds = new Set<string>();
  try {
    const raw = storage.getItem(CHAT_GRID_KEY);
    if (!raw) return protectedIds;
    const parsed = JSON.parse(raw) as {
      threadIds?: unknown;
      focusedThreadId?: unknown;
    };
    if (Array.isArray(parsed?.threadIds)) {
      for (const id of parsed.threadIds) {
        if (typeof id === 'string' && id.length > 0) {
          protectedIds.add(id);
        }
      }
    }
    if (typeof parsed?.focusedThreadId === 'string' && parsed.focusedThreadId.length > 0) {
      protectedIds.add(parsed.focusedThreadId);
    }
  } catch {
    // Ignore invalid grid JSON
  }
  return protectedIds;
}

function safeGetItemLength(storage: Storage, key: string): number | null {
  try {
    const val = storage.getItem(key);
    return val === null ? null : val.length;
  } catch {
    return null;
  }
}

function removeKeySafely(
  storage: Storage,
  key: string,
  removedKeys: string[],
  knownLength?: number
): number {
  const len = knownLength ?? safeGetItemLength(storage, key);
  if (len === null) return 0;
  try {
    storage.removeItem(key);
    removedKeys.push(key);
    return len;
  } catch {
    return 0;
  }
}

function tryRetryWrite(retryWrite?: () => void): boolean {
  if (!retryWrite) return false;
  try {
    retryWrite();
    return true;
  } catch {
    return false;
  }
}

function collectThreadCacheEntries(storage: Storage, keys: string[]): ThreadCacheEntry[] {
  const entries: ThreadCacheEntry[] = [];
  for (const key of keys) {
    if (!key.startsWith(CHAT_THREAD_CACHE_PREFIX)) continue;
    const size = safeGetItemLength(storage, key);
    if (size === null) continue;
    entries.push({
      key,
      threadId: key.slice(CHAT_THREAD_CACHE_PREFIX.length),
      size,
    });
  }
  return entries;
}

/**
 * Safely reclaims oversized or regenerable `localStorage` cache entries whose
 * durable state lives in SQLite, without deleting user configuration, themes,
 * favorite models, prompts, or credentials.
 */
export function reclaimOversizedLocalStorageCaches(
  options: ReclaimLocalStorageOptions = {}
): ReclaimLocalStorageResult {
  const storage =
    options.storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  const removedKeys: string[] = [];
  let freedChars = 0;

  if (!storage) {
    return { removedKeys, freedChars, writeSucceeded: false };
  }

  const keys = snapshotStorageKeys(storage);
  const protectedIds = readProtectedGridThreadIds(storage);
  const aggressive = Boolean(options.aggressive);

  if (!aggressive) {
    for (const key of keys) {
      if (key.startsWith('bmone.')) {
        freedChars += removeKeySafely(storage, key, removedKeys);
      }
    }

    const threadEntries = collectThreadCacheEntries(storage, keys);
    const remaining: ThreadCacheEntry[] = [];
    for (const entry of threadEntries) {
      if (entry.size > LEGACY_OVERSIZED_THREAD_CACHE_CHARS) {
        freedChars += removeKeySafely(storage, entry.key, removedKeys, entry.size);
      } else {
        remaining.push(entry);
      }
    }

    if (remaining.length > MAX_RETAINED_THREAD_CACHE_ENTRIES) {
      const nonProtectedLargest = remaining
        .filter((entry) => !protectedIds.has(entry.threadId))
        .sort((a, b) => b.size - a.size);
      let count = remaining.length;
      for (const entry of nonProtectedLargest) {
        if (count <= MAX_RETAINED_THREAD_CACHE_ENTRIES) break;
        const removed = removeKeySafely(storage, entry.key, removedKeys, entry.size);
        if (removed > 0 || safeGetItemLength(storage, entry.key) === null) {
          freedChars += removed;
          count -= 1;
        }
      }
    }

    return {
      removedKeys,
      freedChars,
      writeSucceeded: tryRetryWrite(options.retryWrite),
    };
  }

  // Aggressive Phase 1: remove regenerable caches, legacy bmone.* entries, and >150KB thread blobs
  let removedInPhase1 = 0;
  const phase1Keys = new Set<string>(REGENERABLE_CACHE_KEYS);
  for (const key of keys) {
    if (key.startsWith('bmone.')) {
      phase1Keys.add(key);
    }
  }
  for (const key of phase1Keys) {
    const delta = removeKeySafely(storage, key, removedKeys);
    if (delta > 0) {
      freedChars += delta;
      removedInPhase1 += 1;
    }
  }

  const threadEntries = collectThreadCacheEntries(storage, keys);
  const survivingThreads: ThreadCacheEntry[] = [];
  for (const entry of threadEntries) {
    if (entry.size > AGGRESSIVE_OVERSIZED_THREAD_CACHE_CHARS) {
      const delta = removeKeySafely(storage, entry.key, removedKeys, entry.size);
      freedChars += delta;
      if (delta > 0) removedInPhase1 += 1;
    } else {
      survivingThreads.push(entry);
    }
  }

  if (removedInPhase1 > 0 && tryRetryWrite(options.retryWrite)) {
    return { removedKeys, freedChars, writeSucceeded: true };
  }

  // Aggressive Phase 2: evict remaining non-protected thread caches largest-first until write fits
  const nonProtectedLargest = survivingThreads
    .filter((entry) => !protectedIds.has(entry.threadId))
    .sort((a, b) => b.size - a.size);
  for (const entry of nonProtectedLargest) {
    const delta = removeKeySafely(storage, entry.key, removedKeys, entry.size);
    freedChars += delta;
    if (tryRetryWrite(options.retryWrite)) {
      return { removedKeys, freedChars, writeSucceeded: true };
    }
  }

  // Aggressive Phase 3: evict chat summaries cache, then protected thread caches largest-first
  if (keys.includes(CHAT_SUMMARIES_KEY)) {
    freedChars += removeKeySafely(storage, CHAT_SUMMARIES_KEY, removedKeys);
    if (tryRetryWrite(options.retryWrite)) {
      return { removedKeys, freedChars, writeSucceeded: true };
    }
  }

  const protectedLargest = survivingThreads
    .filter((entry) => protectedIds.has(entry.threadId))
    .sort((a, b) => b.size - a.size);
  for (const entry of protectedLargest) {
    const delta = removeKeySafely(storage, entry.key, removedKeys, entry.size);
    freedChars += delta;
    if (tryRetryWrite(options.retryWrite)) {
      return { removedKeys, freedChars, writeSucceeded: true };
    }
  }

  return {
    removedKeys,
    freedChars,
    writeSucceeded: tryRetryWrite(options.retryWrite),
  };
}
