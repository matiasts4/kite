import type { OperatorProviderConfig, RealtimeProviderId } from './types';
import {
  OPENCODE_GO_CHAT_BASE_URL,
  normalizeOpenCodeBaseUrl,
} from './modelCatalogs';
import {
  DEFAULT_ARGOS_PERSONA,
  migrateLegacyPersonaName,
  sanitizeArgosFigure,
} from './persona';
import { invokeCommand } from '../../ipc';
import { reclaimOversizedLocalStorageCaches } from '../../storage/localStorageQuota';

export const DEFAULT_REALTIME_ENDPOINTS: Record<RealtimeProviderId, string> = {
  xai: 'wss://api.x.ai/v1/realtime',
  gemini_live:
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
  openai: 'wss://api.openai.com/v1/realtime?model=gpt-realtime',
};

export const DEFAULT_VOICE_IDLE_TIMEOUT_SEC = 180;
export const VALID_VOICE_IDLE_TIMEOUT_SECS = [0, 60, 180, 300] as const;
export const DEFAULT_VOICE_VOLUME = 100;

export function sanitizeRealtimeProvider(value?: unknown): RealtimeProviderId {
  if (value === 'xai' || value === 'gemini_live' || value === 'openai') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'gemini_live' || normalized === 'gemini-live' || normalized === 'gemini') {
      return 'gemini_live';
    }
    if (normalized === 'openai' || normalized === 'openai_realtime' || normalized === 'openai-realtime') {
      return 'openai';
    }
    if (normalized === 'xai' || normalized === 'grok') {
      return 'xai';
    }
  }
  return 'xai';
}

export function sanitizeVoiceIdleTimeoutSec(value?: unknown): number {
  const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof num === 'number' && Number.isFinite(num)) {
    if (num === 0 || num === 60 || num === 180 || num === 300) {
      return num;
    }
  }
  return DEFAULT_VOICE_IDLE_TIMEOUT_SEC;
}

export function sanitizeVoiceVolume(value?: unknown): number {
  const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof num === 'number' && Number.isFinite(num)) {
    return Math.min(100, Math.max(0, num));
  }
  return DEFAULT_VOICE_VOLUME;
}

export const DEFAULT_OPERATOR_CONFIG: OperatorProviderConfig = {
  activeProvider: 'cloudflare',
  opencodeApiKey: '',
  opencodeBaseUrl: OPENCODE_GO_CHAT_BASE_URL,
  opencodeModel: 'deepseek-v4.1-flash',
  opencodeSessionId: '',
  vercelApiKey: '',
  vercelBaseUrl: 'https://ai-gateway.vercel.sh/v1',
  vercelModel: 'deepseek/deepseek-chat',
  cloudflareAccountId: '',
  cloudflareApiToken: '',
  cloudflareGatewaySlug: '',
  cloudflareBaseUrl: 'https://api.cloudflare.com/client/v4/accounts',
  cloudflareModel: '@cf/meta/llama-3.1-8b-instruct-fp8',
  antigravityModel: 'gemini-4-hydrogen-low',
  antigravityCommand: 'agy',
  grokApiKey: '',
  grokBaseUrl: 'https://api.x.ai/v1',
  grokModel: 'grok-4.7',
  grokUseCliSubscription: false,
  grokTranscriptionApiKey: '',
  grokTranscriptionBaseUrl: 'https://api.x.ai/v1',
  grokTranscriptionModel: 'grok-voice-transcribe-2.0',
  offlineSttEngine: 'auto',
  offlineSttModelPath: '',
  voiceTransportMode: 'cascaded',
  realtimeProvider: 'xai',
  realtimeEndpoint: DEFAULT_REALTIME_ENDPOINTS.xai,
  geminiLiveApiKey: '',
  openaiRealtimeApiKey: '',
  voiceIdleTimeoutSec: DEFAULT_VOICE_IDLE_TIMEOUT_SEC,
  voiceVolume: DEFAULT_VOICE_VOLUME,
  ttsEnabled: true,
  ttsLanguage: 'es-ES',
  ttsRate: 1.05,
  ttsEngine: 'browser',
  elevenlabsApiKey: '',
  elevenlabsModel: 'eleven_v4_turbo',
  elevenlabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
  elevenlabsStability: 0.5,
  elevenlabsSimilarity: 0.8,
  persona: DEFAULT_ARGOS_PERSONA,
};

export const OPERATOR_CONFIG_STORAGE_KEY = 'kite.operator.providerConfig.v2';
const CONFIG_STORAGE_KEY = OPERATOR_CONFIG_STORAGE_KEY;
const LEGACY_CONFIG_STORAGE_KEY = 'kite.operator.providerConfig.v1';
const SEED_VERSION_KEY = 'kite_operator_seed_v6';

let localSaveGeneration = 0;
let failedLocalStorageFallback: {
  config: OperatorProviderConfig;
  expectedStaleRaw: string | null;
} | null = null;

function cloneOperatorConfig(cfg: OperatorProviderConfig): OperatorProviderConfig {
  return {
    ...cfg,
    persona: {
      ...DEFAULT_ARGOS_PERSONA,
      ...(cfg.persona ?? {}),
    },
  };
}

function safeGetLocalStorageItem(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeOperatorConfigToLocalStorage(serialized: string): boolean {
  const tryWritePrimary = () => {
    localStorage.setItem(CONFIG_STORAGE_KEY, serialized);
  };

  let wrote = false;
  let lastError: unknown = null;
  try {
    tryWritePrimary();
    wrote = true;
  } catch (err) {
    lastError = err;
    const reclaim = reclaimOversizedLocalStorageCaches({
      aggressive: true,
      retryWrite: tryWritePrimary,
    });
    wrote = reclaim.writeSucceeded;
  }

  if (wrote) {
    failedLocalStorageFallback = null;
    try {
      localStorage.setItem(SEED_VERSION_KEY, '1');
    } catch {
      // Seed marker failure must not discard a persisted config
    }
    return true;
  }

  console.warn(
    '[OperatorConfig] Failed to persist config to localStorage after quota reclaim; keeping in-memory and vault fallback:',
    lastError
  );
  return false;
}

/** Prefer HTTP API when an xAI API key is configured. */
export function shouldUseGrokHttpApi(config: OperatorProviderConfig): boolean {
  return Boolean(config.grokApiKey?.trim());
}

/** Local Grok CLI subscription (no API key). */
export function shouldUseGrokCli(config: OperatorProviderConfig): boolean {
  return !shouldUseGrokHttpApi(config) && config.grokUseCliSubscription;
}

export function loadOperatorConfig(): OperatorProviderConfig {
  try {
    const primaryRaw = safeGetLocalStorageItem(CONFIG_STORAGE_KEY);
    if (failedLocalStorageFallback) {
      if (primaryRaw === failedLocalStorageFallback.expectedStaleRaw) {
        return cloneOperatorConfig(failedLocalStorageFallback.config);
      }
      failedLocalStorageFallback = null;
    }

    const raw = primaryRaw ?? safeGetLocalStorageItem(LEGACY_CONFIG_STORAGE_KEY);
    const legacyGrokTrans = safeGetLocalStorageItem('kite_grok_transcription_api_key') || '';
    if (!raw) {
      return {
        ...DEFAULT_OPERATOR_CONFIG,
        grokTranscriptionApiKey: legacyGrokTrans || DEFAULT_OPERATOR_CONFIG.grokTranscriptionApiKey,
        persona: { ...DEFAULT_ARGOS_PERSONA },
      };
    }
    const parsed = JSON.parse(raw) as Partial<OperatorProviderConfig>;
    const baseUrl = normalizeOpenCodeBaseUrl(parsed.opencodeBaseUrl);
    let model = parsed.opencodeModel || DEFAULT_OPERATOR_CONFIG.opencodeModel;
    if (model === 'deepseek-4.1-flash') {
      model = 'deepseek-v4.1-flash';
    } else if (model === 'jev') {
      model = 'jev-1.13';
    } else if (model === 'deepseek-v4.1-coder') {
      model = 'deepseek-v4.1-flash';
    }

    const apiKey =
      typeof parsed.opencodeApiKey === 'string'
        ? parsed.opencodeApiKey
        : DEFAULT_OPERATOR_CONFIG.opencodeApiKey;

    const vercelKey =
      typeof parsed.vercelApiKey === 'string'
        ? parsed.vercelApiKey
        : DEFAULT_OPERATOR_CONFIG.vercelApiKey;

    const cfAccount =
      typeof parsed.cloudflareAccountId === 'string'
        ? parsed.cloudflareAccountId
        : DEFAULT_OPERATOR_CONFIG.cloudflareAccountId;
    const cfToken =
      typeof parsed.cloudflareApiToken === 'string'
        ? parsed.cloudflareApiToken
        : DEFAULT_OPERATOR_CONFIG.cloudflareApiToken;
    const cfModel = parsed.cloudflareModel || DEFAULT_OPERATOR_CONFIG.cloudflareModel;

    const grokTransKey =
      typeof parsed.grokTranscriptionApiKey === 'string' && parsed.grokTranscriptionApiKey.trim().length > 0
        ? parsed.grokTranscriptionApiKey
        : legacyGrokTrans || DEFAULT_OPERATOR_CONFIG.grokTranscriptionApiKey;

    const activeProvider = parsed.activeProvider || DEFAULT_OPERATOR_CONFIG.activeProvider;
    let antigravityModel =
      parsed.antigravityModel || DEFAULT_OPERATOR_CONFIG.antigravityModel;
    if (
      (antigravityModel === 'gemini-3.8-flash' || antigravityModel === 'gemini-3.8-flash-low') &&
      safeGetLocalStorageItem(SEED_VERSION_KEY) !== '1'
    ) {
      antigravityModel = 'gemini-4-hydrogen-low';
    }

    return {
      ...DEFAULT_OPERATOR_CONFIG,
      ...parsed,
      updatedAtMs:
        typeof parsed.updatedAtMs === 'number' && Number.isFinite(parsed.updatedAtMs)
          ? parsed.updatedAtMs
          : undefined,
      activeProvider,
      antigravityModel,
      opencodeApiKey: apiKey,
      opencodeBaseUrl: baseUrl,
      opencodeModel: model,
      opencodeSessionId:
        typeof parsed.opencodeSessionId === 'string' ? parsed.opencodeSessionId : '',
      vercelApiKey: vercelKey,
      vercelBaseUrl: parsed.vercelBaseUrl || DEFAULT_OPERATOR_CONFIG.vercelBaseUrl,
      vercelModel: parsed.vercelModel || DEFAULT_OPERATOR_CONFIG.vercelModel,
      cloudflareAccountId: cfAccount,
      cloudflareApiToken: cfToken,
      cloudflareGatewaySlug: typeof parsed.cloudflareGatewaySlug === 'string' ? parsed.cloudflareGatewaySlug : DEFAULT_OPERATOR_CONFIG.cloudflareGatewaySlug,
      cloudflareBaseUrl: parsed.cloudflareBaseUrl || DEFAULT_OPERATOR_CONFIG.cloudflareBaseUrl,
      cloudflareModel: cfModel,
      grokTranscriptionApiKey: grokTransKey,
      realtimeProvider: sanitizeRealtimeProvider(parsed.realtimeProvider),
      geminiLiveApiKey:
        typeof parsed.geminiLiveApiKey === 'string'
          ? parsed.geminiLiveApiKey
          : DEFAULT_OPERATOR_CONFIG.geminiLiveApiKey,
      openaiRealtimeApiKey:
        typeof parsed.openaiRealtimeApiKey === 'string'
          ? parsed.openaiRealtimeApiKey
          : DEFAULT_OPERATOR_CONFIG.openaiRealtimeApiKey,
      voiceIdleTimeoutSec: sanitizeVoiceIdleTimeoutSec(parsed.voiceIdleTimeoutSec),
      voiceVolume: sanitizeVoiceVolume(parsed.voiceVolume),
      persona: {
        ...DEFAULT_ARGOS_PERSONA,
        ...(parsed.persona ?? {}),
        name: migrateLegacyPersonaName(parsed.persona?.name),
        figure: sanitizeArgosFigure(parsed.persona?.figure),
      },
    };
  } catch {
    return { ...DEFAULT_OPERATOR_CONFIG, persona: { ...DEFAULT_ARGOS_PERSONA } };
  }
}

export const getOperatorConfig = loadOperatorConfig;

export const OPERATOR_CONFIG_DEBOUNCE_MS = 350;

export type OperatorConfigPatch = Omit<Partial<OperatorProviderConfig>, 'persona'> & {
  persona?: Partial<OperatorProviderConfig['persona']>;
};

let pendingDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingDebouncedPatch: OperatorConfigPatch | null = null;
let pendingFlushListeners: Array<(saved: OperatorProviderConfig) => void> = [];

function mergeOperatorPatch(
  base: OperatorConfigPatch,
  incoming: OperatorConfigPatch
): OperatorConfigPatch {
  const mergedPersona =
    base.persona || incoming.persona
      ? {
          ...(base.persona ?? {}),
          ...(incoming.persona ?? {}),
        }
      : undefined;
  return {
    ...base,
    ...incoming,
    ...(mergedPersona ? { persona: mergedPersona } : {}),
  };
}

/**
 * Pure patch application used by controlled UI state and persistence layers.
 */
export function applyOperatorConfigPatch(
  base: OperatorProviderConfig,
  patch: OperatorConfigPatch
): OperatorProviderConfig {
  return {
    ...base,
    ...patch,
    opencodeBaseUrl: normalizeOpenCodeBaseUrl(
      patch.opencodeBaseUrl ?? base.opencodeBaseUrl
    ),
    realtimeProvider: sanitizeRealtimeProvider(
      patch.realtimeProvider ?? base.realtimeProvider
    ),
    voiceIdleTimeoutSec: sanitizeVoiceIdleTimeoutSec(
      patch.voiceIdleTimeoutSec ?? base.voiceIdleTimeoutSec
    ),
    voiceVolume: sanitizeVoiceVolume(patch.voiceVolume ?? base.voiceVolume),
    persona: {
      ...base.persona,
      ...(patch.persona ?? {}),
      figure: sanitizeArgosFigure(patch.persona?.figure ?? base.persona?.figure),
    },
  };
}

function clearPendingDebounceState(): void {
  if (pendingDebounceTimer !== null) {
    clearTimeout(pendingDebounceTimer);
    pendingDebounceTimer = null;
  }
}

const VAULT_CREDENTIAL_FIELDS: Array<{ provider: string; field: keyof OperatorProviderConfig }> = [
  { provider: 'opencode', field: 'opencodeApiKey' },
  { provider: 'grok', field: 'grokApiKey' },
  { provider: 'grok_transcription', field: 'grokTranscriptionApiKey' },
  { provider: 'vercel', field: 'vercelApiKey' },
  { provider: 'cloudflare', field: 'cloudflareApiToken' },
  { provider: 'cloudflare_account_id', field: 'cloudflareAccountId' },
  { provider: 'elevenlabs', field: 'elevenlabsApiKey' },
  { provider: 'gemini_live', field: 'geminiLiveApiKey' },
  { provider: 'openai_realtime', field: 'openaiRealtimeApiKey' },
];

function persistOperatorConfigSnapshot(
  merged: OperatorProviderConfig,
  prevRaw: string | null
): void {
  const serialized = JSON.stringify(merged);
  if (!writeOperatorConfigToLocalStorage(serialized)) {
    failedLocalStorageFallback = {
      config: cloneOperatorConfig(merged),
      expectedStaleRaw: prevRaw,
    };
  }
}

function dispatchOperatorConfigEvents(merged: OperatorProviderConfig): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('kite:operator-config-updated', { detail: merged }));
  window.dispatchEvent(new CustomEvent('kite:operator-config-changed', { detail: merged }));
}

export function saveOperatorConfig(
  partialOrFull: OperatorConfigPatch
): OperatorProviderConfig {
  clearPendingDebounceState();
  const pendingPatch = pendingDebouncedPatch;
  pendingDebouncedPatch = null;
  const callbacks = pendingFlushListeners;
  pendingFlushListeners = [];

  const effectivePatch = pendingPatch
    ? mergeOperatorPatch(pendingPatch, partialOrFull)
    : partialOrFull;

  localSaveGeneration += 1;
  const prevRaw = safeGetLocalStorageItem(CONFIG_STORAGE_KEY);
  const current = loadOperatorConfig();
  const merged = applyOperatorConfigPatch(current, effectivePatch);
  const prevUpdatedAt =
    typeof current.updatedAtMs === 'number' && Number.isFinite(current.updatedAtMs)
      ? current.updatedAtMs
      : 0;
  merged.updatedAtMs = Math.max(Date.now(), prevUpdatedAt + 1);

  persistOperatorConfigSnapshot(merged, prevRaw);

  if (effectivePatch.grokTranscriptionApiKey !== undefined) {
    try {
      localStorage.setItem(
        'kite_grok_transcription_api_key',
        (merged.grokTranscriptionApiKey ?? '').trim()
      );
    } catch {
      // Non-critical mirror key; primary config and SQLite vault remain authoritative
    }
  }

  if (
    typeof window !== 'undefined' &&
    Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)
  ) {
    const saveCred = (provider: string, nextKey?: string, prevKey?: string) => {
      if (nextKey === undefined) return;
      const trimmedNext = nextKey.trim();
      const trimmedPrev = (prevKey ?? '').trim();
      if (trimmedNext.length > 0 || (trimmedPrev.length > 0 && trimmedNext.length === 0)) {
        void Promise.resolve(
          invokeCommand('save_provider_credential', {
            provider,
            key: trimmedNext,
          })
        ).catch((err) => {
          console.warn('[OperatorConfig] Failed to save provider credential:', provider, err);
        });
      }
    };
    for (const { provider, field } of VAULT_CREDENTIAL_FIELDS) {
      saveCred(
        provider,
        effectivePatch[field] as string | undefined,
        current[field] as string | undefined
      );
    }

    const settingsSnapshot = {
      updatedAtMs: merged.updatedAtMs,
      activeProvider: merged.activeProvider,
      opencodeBaseUrl: merged.opencodeBaseUrl,
      opencodeModel: merged.opencodeModel,
      vercelBaseUrl: merged.vercelBaseUrl,
      vercelModel: merged.vercelModel,
      cloudflareGatewaySlug: merged.cloudflareGatewaySlug,
      cloudflareBaseUrl: merged.cloudflareBaseUrl,
      cloudflareModel: merged.cloudflareModel,
      antigravityModel: merged.antigravityModel,
      antigravityCommand: merged.antigravityCommand,
      grokBaseUrl: merged.grokBaseUrl,
      grokModel: merged.grokModel,
      grokUseCliSubscription: merged.grokUseCliSubscription,
      grokTranscriptionBaseUrl: merged.grokTranscriptionBaseUrl,
      grokTranscriptionModel: merged.grokTranscriptionModel,
      offlineSttEngine: merged.offlineSttEngine,
      offlineSttModelPath: merged.offlineSttModelPath,
      voiceTransportMode: merged.voiceTransportMode,
      realtimeProvider: merged.realtimeProvider,
      realtimeEndpoint: merged.realtimeEndpoint,
      voiceIdleTimeoutSec: merged.voiceIdleTimeoutSec,
      voiceVolume: merged.voiceVolume,
      ttsEnabled: merged.ttsEnabled,
      ttsLanguage: merged.ttsLanguage,
      ttsRate: merged.ttsRate,
      ttsEngine: merged.ttsEngine,
      elevenlabsModel: merged.elevenlabsModel,
      elevenlabsVoiceId: merged.elevenlabsVoiceId,
      elevenlabsStability: merged.elevenlabsStability,
      elevenlabsSimilarity: merged.elevenlabsSimilarity,
      persona: merged.persona,
    };
    void Promise.resolve(
      invokeCommand('save_provider_credential', {
        provider: 'operator_settings_json',
        key: JSON.stringify(settingsSnapshot),
      })
    ).catch((err) => {
      console.warn('[OperatorConfig] Failed to save operator_settings_json to SQLite vault:', err);
    });
  }

  dispatchOperatorConfigEvents(merged);

  for (const cb of callbacks) {
    try {
      cb(merged);
    } catch {
      /* ignore listener errors */
    }
  }
  return merged;
}

/**
 * Flush any pending debounced operator config save immediately (e.g. on blur or unmount).
 */
export function flushOperatorConfigSave(): OperatorProviderConfig | null {
  clearPendingDebounceState();
  if (!pendingDebouncedPatch) {
    pendingFlushListeners = [];
    return null;
  }
  const patch = pendingDebouncedPatch;
  pendingDebouncedPatch = null;
  return saveOperatorConfig(patch);
}

/**
 * Debounce high-frequency operator config writes (localStorage, vault IPC, broadcasts).
 */
export function saveOperatorConfigDebounced(
  partialOrFull: OperatorConfigPatch,
  delayMs = OPERATOR_CONFIG_DEBOUNCE_MS,
  onFlushed?: (saved: OperatorProviderConfig) => void
): void {
  pendingDebouncedPatch = pendingDebouncedPatch
    ? mergeOperatorPatch(pendingDebouncedPatch, partialOrFull)
    : partialOrFull;
  if (onFlushed) {
    pendingFlushListeners.push(onFlushed);
  }
  clearPendingDebounceState();
  pendingDebounceTimer = setTimeout(() => {
    pendingDebounceTimer = null;
    flushOperatorConfigSave();
  }, delayMs);
}

export function resetOperatorConfigDebounceForTest(): void {
  clearPendingDebounceState();
  pendingDebouncedPatch = null;
  pendingFlushListeners = [];
  failedLocalStorageFallback = null;
  localSaveGeneration = 0;
}

function newOpenCodeSessionId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `ses_kite_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    }
  } catch {
    // fall through to the timestamp-based id
  }
  return `ses_kite_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function getOrCreateOpenCodeSessionId(
  config: OperatorProviderConfig = loadOperatorConfig()
): string {
  const existing = config.opencodeSessionId?.trim();
  if (existing) return existing;
  const next = newOpenCodeSessionId();
  saveOperatorConfig({ opencodeSessionId: next });
  return next;
}

export async function syncNativeCredentialsWithVault(): Promise<OperatorProviderConfig> {
  const isTauri =
    typeof window !== 'undefined' &&
    Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);
  if (!isTauri) return loadOperatorConfig();

  try {
    reclaimOversizedLocalStorageCaches({ aggressive: false });
    const startSaveGen = localSaveGeneration;
    const hadStoredConfig = Boolean(
      safeGetLocalStorageItem(CONFIG_STORAGE_KEY) ||
        safeGetLocalStorageItem(LEGACY_CONFIG_STORAGE_KEY)
    );
    const cfg = loadOperatorConfig();
    const records: Record<string, string> = {};
    if (cfg.opencodeApiKey) records['opencode'] = cfg.opencodeApiKey;
    if (cfg.grokApiKey) records['grok'] = cfg.grokApiKey;
    if (cfg.grokTranscriptionApiKey) records['grok_transcription'] = cfg.grokTranscriptionApiKey;
    if (cfg.vercelApiKey) records['vercel'] = cfg.vercelApiKey;
    if (cfg.cloudflareApiToken) records['cloudflare'] = cfg.cloudflareApiToken;
    if (cfg.cloudflareAccountId) records['cloudflare_account_id'] = cfg.cloudflareAccountId;
    if (cfg.elevenlabsApiKey) records['elevenlabs'] = cfg.elevenlabsApiKey;
    if (cfg.geminiLiveApiKey) records['gemini_live'] = cfg.geminiLiveApiKey;
    if (cfg.openaiRealtimeApiKey) records['openai_realtime'] = cfg.openaiRealtimeApiKey;

    const extraGrokTrans = safeGetLocalStorageItem('kite_grok_transcription_api_key');
    if (extraGrokTrans && !records['grok_transcription']) {
      records['grok_transcription'] = extraGrokTrans;
    }

    if (Object.keys(records).length > 0) {
      await Promise.resolve(invokeCommand('migrate_localstorage_credentials', { records })).catch(
        (err) => {
          console.warn('[OperatorConfig] Failed to migrate localStorage credentials to vault:', err);
          return undefined;
        }
      );
    }

    const hydratedPatch: Partial<OperatorProviderConfig> = {};

    const snapRes = await Promise.resolve(
      invokeCommand<{ success?: boolean; key?: string | null }>(
        'get_active_provider_key',
        { provider: 'operator_settings_json' }
      )
    ).catch((err) => {
      console.warn('[OperatorConfig] Failed to load operator_settings_json from vault:', err);
      return null;
    });
    if (snapRes?.key && typeof snapRes.key === 'string') {
      try {
        const parsedSnap = JSON.parse(snapRes.key) as Partial<OperatorProviderConfig>;
        if (parsedSnap && typeof parsedSnap === 'object') {
          const vaultUpdatedAt =
            typeof parsedSnap.updatedAtMs === 'number' && Number.isFinite(parsedSnap.updatedAtMs)
              ? parsedSnap.updatedAtMs
              : 0;
          const localUpdatedAt =
            typeof cfg.updatedAtMs === 'number' && Number.isFinite(cfg.updatedAtMs)
              ? cfg.updatedAtMs
              : 0;
          if (!hadStoredConfig || vaultUpdatedAt > localUpdatedAt) {
            Object.assign(hydratedPatch, parsedSnap);
          }
        }
      } catch {
        // ignore invalid json
      }
    }

    for (const { provider, field } of VAULT_CREDENTIAL_FIELDS) {
      const currentVal = (cfg[field] as string | undefined)?.trim() || '';
      if (!currentVal) {
        const res = await Promise.resolve(
          invokeCommand<{ success?: boolean; key?: string | null }>(
            'get_active_provider_key',
            { provider }
          )
        ).catch((err) => {
          console.warn('[OperatorConfig] Failed to read provider key from vault:', provider, err);
          return null;
        });
        const vaultKey = typeof res?.key === 'string' ? res.key.trim() : '';
        if (vaultKey.length > 0) {
          (hydratedPatch as any)[field] = vaultKey;
          if (provider === 'grok_transcription') {
            try {
              localStorage.setItem('kite_grok_transcription_api_key', vaultKey);
            } catch {
              // Ignore non-critical mirror error
            }
          }
          if (provider === 'elevenlabs' && !hadStoredConfig && !hydratedPatch.ttsEngine) {
            hydratedPatch.ttsEngine = 'elevenlabs';
          }
        }
      }
    }

    if (Object.keys(hydratedPatch).length > 0) {
      const latest = loadOperatorConfig();
      let effectivePatch: Partial<OperatorProviderConfig> = hydratedPatch;
      if (localSaveGeneration !== startSaveGen) {
        const credentialOnlyPatch: Partial<OperatorProviderConfig> = {};
        for (const { field } of VAULT_CREDENTIAL_FIELDS) {
          const incoming = hydratedPatch[field];
          const currentVal = (latest[field] as string | undefined)?.trim() || '';
          if (typeof incoming === 'string' && incoming.trim().length > 0 && !currentVal) {
            (credentialOnlyPatch as Record<string, unknown>)[field] = incoming;
          }
        }
        effectivePatch = credentialOnlyPatch;
      }

      if (Object.keys(effectivePatch).length > 0) {
        if (
          (effectivePatch.antigravityModel === 'gemini-3.8-flash' ||
            effectivePatch.antigravityModel === 'gemini-3.8-flash-low') &&
          safeGetLocalStorageItem(SEED_VERSION_KEY) !== '1'
        ) {
          effectivePatch.antigravityModel = 'gemini-4-hydrogen-low';
        }
        const merged: OperatorProviderConfig = {
          ...latest,
          ...effectivePatch,
          realtimeProvider: sanitizeRealtimeProvider(
            effectivePatch.realtimeProvider ?? latest.realtimeProvider
          ),
          voiceIdleTimeoutSec: sanitizeVoiceIdleTimeoutSec(
            effectivePatch.voiceIdleTimeoutSec ?? latest.voiceIdleTimeoutSec
          ),
          voiceVolume: sanitizeVoiceVolume(
            effectivePatch.voiceVolume ?? latest.voiceVolume
          ),
          persona: {
            ...latest.persona,
            ...(effectivePatch.persona ?? {}),
            name: migrateLegacyPersonaName(
              effectivePatch.persona?.name ?? latest.persona?.name
            ),
            figure: sanitizeArgosFigure(
              effectivePatch.persona?.figure ?? latest.persona?.figure
            ),
          },
        };
        const prevRaw = safeGetLocalStorageItem(CONFIG_STORAGE_KEY);
        persistOperatorConfigSnapshot(merged, prevRaw);
        dispatchOperatorConfigEvents(merged);
        return merged;
      }
    }
  } catch {
    // ignore migration errors
  }
  return loadOperatorConfig();
}

if (typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)) {
  void syncNativeCredentialsWithVault();
}
