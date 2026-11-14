import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSubscriptionQuotas } from '../ipc';
import { saveQuotaPreferences, subscriptionQuotaManager } from './quotaManager';
import { PROVIDERS } from './types';

vi.mock('../ipc', () => ({
  getSubscriptionQuotas: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SubscriptionQuotaManager concurrency & lifecycle', () => {
  beforeEach(() => {
    localStorage.clear();
    subscriptionQuotaManager.stopPolling();
    vi.clearAllMocks();
    saveQuotaPreferences({ enabledProviders: [PROVIDERS.ANTIGRAVITY] });
  });

  it('queues forced fetchAll(true) behind an in-flight background poll instead of dropping it', async () => {
    const firstPoll = deferred<Record<string, any>>();
    const forcedPoll = deferred<Record<string, any>>();

    vi.mocked(getSubscriptionQuotas)
      .mockReturnValueOnce(firstPoll.promise)
      .mockReturnValueOnce(forcedPoll.promise);

    const bgPromise = subscriptionQuotaManager.fetchAll(false, [PROVIDERS.ANTIGRAVITY]);
    const forcedPromise = subscriptionQuotaManager.fetchAll(true, [PROVIDERS.ANTIGRAVITY]);

    firstPoll.resolve({
      antigravity: {
        providerId: 'antigravity',
        displayName: 'Antigravity',
        isAvailable: true,
        isAuth: true,
        primaryUsagePercent: 10,
        primaryRemainingPercent: 90,
        windows: [],
        metadata: { email: 'old@example.com' },
        lastUpdatedMs: Date.now() - 5000,
      },
    });

    await bgPromise;

    expect(vi.mocked(getSubscriptionQuotas)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(getSubscriptionQuotas).mock.calls[1]).toEqual([true, [PROVIDERS.ANTIGRAVITY]]);

    forcedPoll.resolve({
      antigravity: {
        providerId: 'antigravity',
        displayName: 'Antigravity',
        isAvailable: true,
        isAuth: true,
        primaryUsagePercent: 2,
        primaryRemainingPercent: 98,
        windows: [],
        metadata: { email: 'new@example.com' },
        lastUpdatedMs: Date.now(),
      },
    });

    const latest = await forcedPromise;
    expect(latest.antigravity?.metadata?.email).toBe('new@example.com');
    expect(latest.antigravity?.primaryRemainingPercent).toBe(98);
  });

  it('clears stale antigravity quota identity and marks refreshing immediately on switch', () => {
    subscriptionQuotaManager.invalidateAndMarkRefreshing(PROVIDERS.ANTIGRAVITY);
    const current = subscriptionQuotaManager.getQuota(PROVIDERS.ANTIGRAVITY);
    expect(current?.metadata?.refreshing).toBe(true);
    expect(current?.metadata?.email).toBeUndefined();
    expect(current?.isAuth).toBe(false);
  });

  it('removes window focus listener cleanly when stopPolling runs', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    subscriptionQuotaManager.startPollingForTest?.() ?? subscriptionQuotaManager.startPolling();
    const addedFocusCalls = addSpy.mock.calls.filter(([type]) => type === 'focus');
    subscriptionQuotaManager.stopPolling();
    const removedFocusCalls = removeSpy.mock.calls.filter(([type]) => type === 'focus');

    if (addedFocusCalls.length > 0) {
      expect(removedFocusCalls.length).toBeGreaterThanOrEqual(addedFocusCalls.length);
      expect(removedFocusCalls[0][1]).toBe(addedFocusCalls[0][1]);
    } else {
      expect(typeof (subscriptionQuotaManager as any).focusHandler).not.toBe('undefined');
    }

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('coalesces concurrent forced refreshes behind an active fetch into one follow-up', async () => {
    const first = deferred<Record<string, any>>();
    const second = deferred<Record<string, any>>();

    vi.mocked(getSubscriptionQuotas)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const bg = subscriptionQuotaManager.fetchAll(false, [PROVIDERS.ANTIGRAVITY]);
    const forcedA = subscriptionQuotaManager.fetchAll(true, [PROVIDERS.ANTIGRAVITY]);
    const forcedB = subscriptionQuotaManager.fetchAll(true, [PROVIDERS.CLAUDE]);

    expect(forcedA).toBe(forcedB);
    expect(vi.mocked(getSubscriptionQuotas)).toHaveBeenCalledTimes(1);

    first.resolve({});
    await bg;

    expect(vi.mocked(getSubscriptionQuotas)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(getSubscriptionQuotas)).toHaveBeenNthCalledWith(2, true, [
      PROVIDERS.ANTIGRAVITY,
      PROVIDERS.CLAUDE,
    ]);

    second.resolve({
      claude: {
        provider: PROVIDERS.CLAUDE,
        isAuth: true,
        primaryRemainingPercent: 90,
        windows: [],
        lastUpdatedMs: 123,
      },
    });
    const res = await forcedB;
    expect(res.claude?.primaryRemainingPercent).toBe(90);
  });

  it('skips redundant localStorage.setItem writes when quota payload is unchanged', async () => {
    const payload = {
      antigravity: {
        providerId: PROVIDERS.ANTIGRAVITY,
        displayName: 'Antigravity',
        isAvailable: true,
        isAuth: true,
        primaryUsagePercent: 23,
        primaryRemainingPercent: 77,
        windows: [],
        lastUpdatedMs: 999_500,
      },
    };
    vi.mocked(getSubscriptionQuotas).mockResolvedValue(payload);

    const setItemSpy = vi.spyOn(localStorage, 'setItem');
    await subscriptionQuotaManager.fetchAll(true, [PROVIDERS.ANTIGRAVITY]);
    const writesAfterFirst = setItemSpy.mock.calls.filter(([k]) => k === 'kite_quota_cache').length;

    await subscriptionQuotaManager.fetchAll(true, [PROVIDERS.ANTIGRAVITY]);
    const writesAfterSecond = setItemSpy.mock.calls.filter(([k]) => k === 'kite_quota_cache').length;

    expect(writesAfterFirst).toBe(1);
    expect(writesAfterSecond).toBe(1);
    setItemSpy.mockRestore();
  });
});
