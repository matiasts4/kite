import { getSubscriptionQuotas, listConnections, type ConnectionSummary } from '../ipc';
import {
  type ProviderQuotaStatus,
  type QuotaPreferences,
  DEFAULT_QUOTA_PREFERENCES,
  PROVIDERS,
  QUOTA_SETUP_VERSION,
  normalizeProviderIds,
  normalizeProviderOrder,
  resolveEnabledProviderIds,
} from './types';

const PREFS_STORAGE_KEY = 'kite_quota_preferences';
const CACHE_STORAGE_KEY = 'kite_quota_cache';
export const QUOTA_PREFS_CHANGED_EVENT = 'kite:quota-preferences-changed';

export function readQuotaCache(): Record<string, ProviderQuotaStatus> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(CACHE_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return {};
}

export function saveQuotaCache(cache: Record<string, ProviderQuotaStatus>) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch (_) {}
}

export function readQuotaPreferences(): QuotaPreferences {
  if (typeof window === 'undefined') return DEFAULT_QUOTA_PREFERENCES;
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const setupVersion =
        parsed && Number.isFinite(parsed.setupVersion)
          ? Number(parsed.setupVersion)
          : 1; // legacy installs never stored a setupVersion
      const providerOrder = normalizeProviderOrder(parsed?.providerOrder);
      const enabledProviders = Array.isArray(parsed?.enabledProviders)
        ? normalizeProviderIds(parsed.enabledProviders)
        : // Legacy prefs without the field meant "everything enabled"; the
          // one-time setup migration resets the monitored list to empty.
          setupVersion < QUOTA_SETUP_VERSION
          ? providerOrder
          : [];
      return {
        ...DEFAULT_QUOTA_PREFERENCES,
        ...parsed,
        setupVersion,
        providerOrder,
        enabledProviders,
      };
    }
  } catch (_) {}
  return DEFAULT_QUOTA_PREFERENCES;
}

export function saveQuotaPreferences(prefs: Partial<QuotaPreferences>): QuotaPreferences {
  const current = readQuotaPreferences();
  const next: QuotaPreferences = {
    ...current,
    ...prefs,
    providerOrder: normalizeProviderOrder(prefs.providerOrder ?? current.providerOrder),
    enabledProviders: normalizeProviderIds(
      prefs.enabledProviders ?? current.enabledProviders
    ),
  };
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(QUOTA_PREFS_CHANGED_EVENT, { detail: next }));
  } catch (_) {}
  return next;
}

export function needsQuotaSetupMigration(): boolean {
  return (readQuotaPreferences().setupVersion ?? 1) < QUOTA_SETUP_VERSION;
}

export function detectProviderFromSession(text: string | null | undefined): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower.includes('antigravity')) {
    return PROVIDERS.ANTIGRAVITY;
  }
  if (lower.includes('qoder')) {
    return PROVIDERS.QODER;
  }
  if (lower.includes('claude') || lower.includes('sonnet') || lower.includes('opus') || lower.includes('anthropic')) {
    return PROVIDERS.CLAUDE;
  }
  if (lower.includes('codex') || lower.includes('openai') || lower.includes('chatgpt') || lower.includes('gpt')) {
    return PROVIDERS.CODEX;
  }
  if (lower.includes('opencode') || lower.includes('open-code')) {
    return PROVIDERS.OPENCODE;
  }
  if (lower.includes('grok') || lower.includes('xai')) {
    return PROVIDERS.GROK;
  }
  if (lower.includes('gemini') || lower.includes('google')) {
    return PROVIDERS.GEMINI;
  }
  if (lower.includes('cursor')) {
    return PROVIDERS.CURSOR;
  }
  if (lower.includes('droid') || lower.includes('factory')) {
    return PROVIDERS.DROID;
  }
  if (lower.includes('copilot') || lower.includes('github')) {
    return PROVIDERS.COPILOT;
  }
  if (lower.includes('deepseek') || lower.includes('deep-seek')) {
    return PROVIDERS.DEEPSEEK;
  }
  if (lower.includes('kimi') || lower.includes('moonshot')) {
    return PROVIDERS.KIMI;
  }
  return null;
}

export function resolveDisplayProvider(
  prefs: QuotaPreferences,
  detected: string | null,
  quotas: Record<string, ProviderQuotaStatus>
): string | null {
  const candidateOrder = resolveEnabledProviderIds(prefs);

  if (candidateOrder.length === 0) {
    return null;
  }

  // 1. If user pinned a specific provider and it is enabled, stick to it
  if (prefs.pinnedProvider && candidateOrder.includes(prefs.pinnedProvider)) {
    return prefs.pinnedProvider;
  }

  // 2. If auto-detect is enabled and the session provider is enabled and has actual valid data
  if (prefs.autoDetectActive && detected && candidateOrder.includes(detected)) {
    const detectedQuota = quotas[detected];
    if (detectedQuota && detectedQuota.isAvailable && (!detectedQuota.error || (detectedQuota.windows && detectedQuota.windows.length > 0))) {
      return detected;
    }
  }

  // 3. Fall back to first enabled provider that has real live data
  for (const id of candidateOrder) {
    const q = quotas[id];
    if (q && q.isAvailable && q.windows && q.windows.length > 0) {
      return id;
    }
  }

  // 4. Any enabled provider that has a recorded quota object
  for (const id of candidateOrder) {
    if (quotas[id]) return id;
  }

  return candidateOrder[0] || null;
}

/** Endpoint ids that prove a quota read: the usage route, the Console status
 * route, and the local RPC quota route. None of them proves a chat endpoint. */
const QUOTA_ENDPOINT_SUFFIXES = ['/usage', '/api/go/status'];
const QUOTA_ENDPOINT_PREFIXES = ['rpc:'];

export function isVerifiedQuotaEndpoint(endpointId: string): boolean {
  const id = endpointId.trim();
  return (
    QUOTA_ENDPOINT_SUFFIXES.some((suffix) => id.endsWith(suffix)) ||
    QUOTA_ENDPOINT_PREFIXES.some((prefix) => id.startsWith(prefix))
  );
}

/**
 * Projects the shared connection registry onto the quota surface. A connection
 * is listed only when one of its own quota endpoints is verified; its driver id
 * alone never qualifies it.
 */
export function quotaConnections(connections: ConnectionSummary[]): ConnectionSummary[] {
  return connections.filter((connection) =>
    connection.endpoints.some(
      (endpoint) => endpoint.ok && isVerifiedQuotaEndpoint(endpoint.endpointId)
    )
  );
}

export async function listQuotaConnections(): Promise<ConnectionSummary[]> {
  try {
    return quotaConnections(await listConnections());
  } catch {
    // A browser build, or a test double without the registry reader, shows no
    // rows instead of claiming a connection.
    return [];
  }
}

class SubscriptionQuotaManager {
  private cache: Map<string, ProviderQuotaStatus> = new Map();
  private subscribers: Set<(quotas: Record<string, ProviderQuotaStatus>) => void> = new Set();
  private pollIntervalMs = 90000;
  private timer: any = null;
  private startupTimer: any = null;
  private isPolling = false;
  private isFetching = false;
  private tauriListenerRegistered = false;

  constructor() {
    // Populate cache immediately from localStorage for 0ms initial render
    const saved = readQuotaCache();
    for (const [k, v] of Object.entries(saved)) {
      this.cache.set(k, v);
    }
    // Upgrade legacy "everything enabled" prefs before the first render.
    this.migrateLegacySetup();
    this.setupTauriListener();
  }

  private setupTauriListener() {
    if (this.tauriListenerRegistered || typeof window === 'undefined') return;
    this.tauriListenerRegistered = true;

    // Listen to background push events from Tauri backend
    if (
      typeof (window as any).__TAURI_INTERNALS__ !== 'undefined' ||
      typeof (window as any).__TAURI__ !== 'undefined'
    ) {
      import('@tauri-apps/api/event')
        .then(({ listen }) => {
          listen<Record<string, ProviderQuotaStatus>>('kite://subscription-quotas-updated', (event) => {
            if (event.payload && typeof event.payload === 'object') {
              for (const [key, val] of Object.entries(event.payload)) {
                if (val && typeof val === 'object') {
                  this.cache.set(key, val);
                }
              }
              saveQuotaCache(this.getAllQuotas());
              this.notify();
            }
          }).catch(() => {});
        })
        .catch(() => {});
    }
  }

  subscribe(callback: (quotas: Record<string, ProviderQuotaStatus>) => void): () => void {
    this.subscribers.add(callback);
    callback(this.getAllQuotas());

    if (!this.isPolling && this.subscribers.size > 0) {
      this.startPolling();
    }

    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) {
        this.stopPolling();
      }
    };
  }

  startPolling() {
    if (this.isPolling) return;
    this.isPolling = true;

    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      void this.fetchAll(false);
    };

    const isTest =
      (typeof (globalThis as any).process !== 'undefined' && (globalThis as any).process?.env?.NODE_ENV === 'test') ||
      import.meta.env?.MODE === 'test';
    if (!isTest) {
      // Defer initial network fetch by 4 seconds so app opens with 0 lag and full CPU availability
      this.startupTimer = setTimeout(() => {
        if (this.isPolling) {
          tick();
        }
      }, 4000);

      this.timer = setInterval(tick, this.pollIntervalMs);

      if (typeof window !== 'undefined') {
        window.addEventListener('focus', tick);
      }
    }
  }

  stopPolling() {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isPolling = false;
  }

  /**
   * One-time upgrade from the legacy "all providers enabled" default.
   * Monitoring starts empty so the user explicitly adds what they use; keys,
   * CLI sessions and account vaults live elsewhere and are never touched.
   */
  private migrateLegacySetup(): QuotaPreferences {
    const legacy = readQuotaPreferences();
    if ((legacy.setupVersion ?? 1) >= QUOTA_SETUP_VERSION) return legacy;
    return saveQuotaPreferences({
      enabledProviders: [],
      pinnedProvider: null,
      setupVersion: QUOTA_SETUP_VERSION,
    });
  }

  async fetchAll(force: boolean = false, providersOverride?: string[]): Promise<Record<string, ProviderQuotaStatus>> {
    if (this.isFetching) return this.getAllQuotas();
    this.isFetching = true;
    try {
      let prefs = readQuotaPreferences();
      if (needsQuotaSetupMigration()) {
        prefs = this.migrateLegacySetup();
      }
      const providers = providersOverride ?? resolveEnabledProviderIds(prefs);
      // Nothing added: do not poll every backend provider behind the user's back.
      if (providers.length === 0) {
        return this.getAllQuotas();
      }
      const data = await getSubscriptionQuotas(force, providers);
      if (data && typeof data === 'object') {
        for (const [key, val] of Object.entries(data)) {
          if (val && typeof val === 'object') {
            this.cache.set(key, val as ProviderQuotaStatus);
          }
        }
        saveQuotaCache(this.getAllQuotas());
        this.notify();
      }
    } catch (err) {
      console.warn('[SubscriptionQuotaManager] fetch failed:', err);
    } finally {
      this.isFetching = false;
    }
    return this.getAllQuotas();
  }

  getQuota(providerId: string): ProviderQuotaStatus | null {
    return this.cache.get(providerId) || null;
  }

  getAllQuotas(): Record<string, ProviderQuotaStatus> {
    const result: Record<string, ProviderQuotaStatus> = {};
    for (const [k, v] of this.cache.entries()) {
      result[k] = v;
    }
    return result;
  }

  private notify() {
    const all = this.getAllQuotas();
    for (const sub of this.subscribers) {
      try {
        sub(all);
      } catch (err) {
        console.error('[SubscriptionQuotaManager] subscriber error:', err);
      }
    }
  }
}

export const subscriptionQuotaManager = new SubscriptionQuotaManager();
