import { describe, expect, it } from 'vitest';
import {
  CHAT_GRID_KEY,
  CHAT_SUMMARIES_KEY,
  CHAT_THREAD_CACHE_PREFIX,
  LEGACY_OVERSIZED_THREAD_CACHE_CHARS,
  MAX_RETAINED_THREAD_CACHE_ENTRIES,
  reclaimOversizedLocalStorageCaches,
} from './localStorageQuota';

function createQuotaCappedStorage(maxChars: number): Storage {
  const data = new Map<string, string>();
  const totalChars = () => {
    let total = 0;
    for (const [k, v] of data.entries()) {
      total += k.length + v.length;
    }
    return total;
  };
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.has(key) ? (data.get(key) ?? null) : null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      const next = new Map(data);
      next.set(key, String(value));
      let total = 0;
      for (const [k, v] of next.entries()) {
        total += k.length + v.length;
      }
      if (total > maxChars && total >= totalChars()) {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      }
      data.set(key, String(value));
    },
  };
}

describe('reclaimOversizedLocalStorageCaches', () => {
  it('non-aggressive startup cleanup removes >200KB thread blobs, bmone.* keys, and excess non-grid threads while preserving user data', () => {
    const storage = createQuotaCappedStorage(20_000_000);
    storage.setItem(
      'kite.operator.providerConfig.v2',
      JSON.stringify({ activeProvider: 'opencode' })
    );
    storage.setItem('kite.themeCustomizations', '{"darkThemeId":"kite-dark"}');
    storage.setItem('kite_favorite_models_v1', '[{"provider":"antigravity"}]');
    storage.setItem('kite_user_prompts', '[{"id":"p1"}]');
    storage.setItem('kite_last_selected_provider', 'antigravity');
    storage.setItem('kite_grok_transcription_api_key', 'xai-stt');
    storage.setItem('bmone.cached_agents', 'x'.repeat(500));
    storage.setItem(
      CHAT_GRID_KEY,
      JSON.stringify({ threadIds: ['active-1'], focusedThreadId: 'active-1' })
    );
    storage.setItem(
      `${CHAT_THREAD_CACHE_PREFIX}legacy-big`,
      'b'.repeat(LEGACY_OVERSIZED_THREAD_CACHE_CHARS + 50)
    );
    storage.setItem(`${CHAT_THREAD_CACHE_PREFIX}active-1`, 'a'.repeat(1_500));

    // Create 10 extra small non-grid threads so total small threads = 11 (> 8 cap)
    for (let i = 1; i <= 10; i += 1) {
      storage.setItem(`${CHAT_THREAD_CACHE_PREFIX}extra-${i}`, 'z'.repeat(1_000 + i * 100));
    }

    const result = reclaimOversizedLocalStorageCaches({ aggressive: false, storage });

    expect(result.removedKeys).toContain('bmone.cached_agents');
    expect(result.removedKeys).toContain(`${CHAT_THREAD_CACHE_PREFIX}legacy-big`);

    const remainingThreadKeys = Array.from({ length: storage.length }, (_, i) => storage.key(i)!)
      .filter((k) => k.startsWith(CHAT_THREAD_CACHE_PREFIX));
    expect(remainingThreadKeys.length).toBeLessThanOrEqual(MAX_RETAINED_THREAD_CACHE_ENTRIES);
    expect(storage.getItem(`${CHAT_THREAD_CACHE_PREFIX}active-1`)).not.toBeNull();

    // User settings and metadata must never be deleted
    expect(storage.getItem('kite.operator.providerConfig.v2')).not.toBeNull();
    expect(storage.getItem('kite.themeCustomizations')).not.toBeNull();
    expect(storage.getItem('kite_favorite_models_v1')).not.toBeNull();
    expect(storage.getItem('kite_user_prompts')).not.toBeNull();
    expect(storage.getItem('kite_last_selected_provider')).toBe('antigravity');
    expect(storage.getItem('kite_grok_transcription_api_key')).toBe('xai-stt');
  });

  it('aggressive mode reclaims space incrementally on QuotaExceededError until retryWrite succeeds without deleting user settings', () => {
    const storage = createQuotaCappedStorage(24_800);
    storage.setItem('kite.operator.providerConfig.v2', '{"activeProvider":"opencode"}');
    storage.setItem('kite_favorite_models_v1', '[]');
    storage.setItem('kite.themeCustomizations', '{"schemaVersion":1}');
    storage.setItem(
      CHAT_GRID_KEY,
      JSON.stringify({ threadIds: ['pinned-thread'], focusedThreadId: 'pinned-thread' })
    );
    storage.setItem(`${CHAT_THREAD_CACHE_PREFIX}pinned-thread`, 'p'.repeat(4_000));
    storage.setItem(`${CHAT_THREAD_CACHE_PREFIX}orphan-1`, '1'.repeat(10_000));
    storage.setItem(`${CHAT_THREAD_CACHE_PREFIX}orphan-2`, '2'.repeat(10_000));
    storage.setItem(CHAT_SUMMARIES_KEY, 's'.repeat(400));

    const payload = JSON.stringify({
      activeProvider: 'antigravity',
      antigravityModel: 'gemini-4-hydrogen-low',
      extraPadding: 'x'.repeat(200),
    });

    // Confirm write initially fails due to exhausted quota
    expect(() => storage.setItem('kite.operator.providerConfig.v2', payload)).toThrow();

    const result = reclaimOversizedLocalStorageCaches({
      aggressive: true,
      storage,
      retryWrite: () => storage.setItem('kite.operator.providerConfig.v2', payload),
    });

    expect(result.writeSucceeded).toBe(true);
    expect(storage.getItem('kite.operator.providerConfig.v2')).toBe(payload);
    // Orphan threads evicted in Phase 2, leaving pinned thread and summaries intact once enough space is freed
    expect(result.removedKeys).toContain(`${CHAT_THREAD_CACHE_PREFIX}orphan-1`);
    expect(storage.getItem(`${CHAT_THREAD_CACHE_PREFIX}pinned-thread`)).not.toBeNull();
    expect(storage.getItem('kite_favorite_models_v1')).toBe('[]');
    expect(storage.getItem('kite.themeCustomizations')).toBe('{"schemaVersion":1}');
  });
});
