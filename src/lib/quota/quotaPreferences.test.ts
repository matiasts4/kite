import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSubscriptionQuotas } from '../ipc';
import {
  DEFAULT_QUOTA_PREFERENCES,
  PROVIDERS,
  QUOTA_SETUP_VERSION,
  resolveEnabledProviderIds,
} from './types';
import {
  needsQuotaSetupMigration,
  readQuotaPreferences,
  saveQuotaPreferences,
  subscriptionQuotaManager,
} from './quotaManager';

vi.mock('../ipc', () => ({
  getSubscriptionQuotas: vi.fn().mockResolvedValue({}),
}));

const PREFS_STORAGE_KEY = 'kite_quota_preferences';

describe('quota preferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts with no providers enabled on a fresh install', () => {
    const prefs = readQuotaPreferences();
    expect(prefs.enabledProviders).toEqual([]);
    expect(prefs.setupVersion).toBe(QUOTA_SETUP_VERSION);
    expect(needsQuotaSetupMigration()).toBe(false);
  });

  it('marks legacy preferences for the one-time provider migration', () => {
    localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_QUOTA_PREFERENCES,
        setupVersion: undefined,
        enabledProviders: [PROVIDERS.ANTIGRAVITY, PROVIDERS.GROK, PROVIDERS.OPENCODE],
      })
    );

    const prefs = readQuotaPreferences();
    expect(prefs.setupVersion).toBe(1);
    expect(needsQuotaSetupMigration()).toBe(true);
    expect(prefs.enabledProviders).toEqual([
      PROVIDERS.ANTIGRAVITY,
      PROVIDERS.GROK,
      PROVIDERS.OPENCODE,
    ]);
  });

  it('preserves the user order and excludes disabled providers from the tab list', () => {
    const ids = resolveEnabledProviderIds({
      providerOrder: [PROVIDERS.GROK, PROVIDERS.OPENCODE, PROVIDERS.ANTIGRAVITY],
      enabledProviders: [PROVIDERS.OPENCODE, PROVIDERS.ANTIGRAVITY],
    });

    expect(ids).toEqual([PROVIDERS.OPENCODE, PROVIDERS.ANTIGRAVITY]);
  });

  it('normalizes unknown and duplicated provider ids when saving', () => {
    saveQuotaPreferences({
      enabledProviders: [PROVIDERS.GROK, 'not-a-provider', PROVIDERS.GROK],
      providerOrder: [PROVIDERS.OPENCODE, PROVIDERS.OPENCODE, 'nope'],
    });

    const prefs = readQuotaPreferences();
    expect(prefs.enabledProviders).toEqual([PROVIDERS.GROK]);
    expect(prefs.providerOrder[0]).toBe(PROVIDERS.OPENCODE);
    expect(prefs.providerOrder).toHaveLength(12);
    expect(new Set(prefs.providerOrder).size).toBe(12);
  });

  it('migrates legacy installs to an empty monitored list without polling providers', async () => {
    localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_QUOTA_PREFERENCES,
        setupVersion: undefined,
        enabledProviders: [PROVIDERS.ANTIGRAVITY, PROVIDERS.GROK, PROVIDERS.OPENCODE],
        pinnedProvider: PROVIDERS.QODER,
      })
    );
    vi.mocked(getSubscriptionQuotas).mockClear();

    await subscriptionQuotaManager.fetchAll(false);

    const prefs = readQuotaPreferences();
    expect(prefs.enabledProviders).toEqual([]);
    expect(prefs.pinnedProvider).toBeNull();
    expect(prefs.setupVersion).toBe(QUOTA_SETUP_VERSION);
    expect(getSubscriptionQuotas).not.toHaveBeenCalled();
  });
});
