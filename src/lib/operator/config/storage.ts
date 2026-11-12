import type { OperatorProviderConfig } from './types';
import {
  OPENCODE_GO_CHAT_BASE_URL,
  normalizeOpenCodeBaseUrl,
} from './modelCatalogs';
import { DEFAULT_ZED_PERSONA } from './persona';
import { invokeCommand } from '../../ipc';

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
  antigravityModel: 'gemini-3.8-flash',
  antigravityCommand: 'agy',
  grokApiKey: '',
  grokBaseUrl: 'https://api.x.ai/v1',
  grokModel: 'grok-4.7',
  grokUseCliSubscription: false,
  grokTranscriptionApiKey: '',
  grokTranscriptionBaseUrl: 'https://api.x.ai/v1',
  grokTranscriptionModel: 'grok-voice-transcribe-2.0',
  ttsEnabled: true,
  ttsLanguage: 'es-ES',
  ttsRate: 1.05,
  ttsEngine: 'browser',
  elevenlabsApiKey: '',
  elevenlabsModel: 'eleven_v4_turbo',
  elevenlabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
  elevenlabsStability: 0.5,
  elevenlabsSimilarity: 0.8,
  persona: DEFAULT_ZED_PERSONA,
};

const CONFIG_STORAGE_KEY = 'kite.operator.providerConfig.v2';
const LEGACY_CONFIG_STORAGE_KEY = 'kite.operator.providerConfig.v1';
const SEED_VERSION_KEY = 'kite_operator_seed_v4';

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
    const raw =
      localStorage.getItem(CONFIG_STORAGE_KEY) ??
      localStorage.getItem(LEGACY_CONFIG_STORAGE_KEY);
    const legacyGrokTrans = localStorage.getItem('kite_grok_transcription_api_key') || '';
    if (!raw) {
      return {
        ...DEFAULT_OPERATOR_CONFIG,
        grokTranscriptionApiKey: legacyGrokTrans || DEFAULT_OPERATOR_CONFIG.grokTranscriptionApiKey,
        persona: { ...DEFAULT_ZED_PERSONA },
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

    return {
      ...DEFAULT_OPERATOR_CONFIG,
      ...parsed,
      activeProvider,
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
      persona: {
        ...DEFAULT_ZED_PERSONA,
        ...(parsed.persona ?? {}),
      },
    };
  } catch {
    return { ...DEFAULT_OPERATOR_CONFIG, persona: { ...DEFAULT_ZED_PERSONA } };
  }
}

export const getOperatorConfig = loadOperatorConfig;

export function saveOperatorConfig(
  partialOrFull: Partial<OperatorProviderConfig>
): OperatorProviderConfig {
  const current = loadOperatorConfig();
  const merged: OperatorProviderConfig = {
    ...current,
    ...partialOrFull,
    opencodeBaseUrl: normalizeOpenCodeBaseUrl(
      partialOrFull.opencodeBaseUrl ?? current.opencodeBaseUrl
    ),
    persona: {
      ...current.persona,
      ...(partialOrFull.persona ?? {}),
    },
  };
  try {
    localStorage.setItem(SEED_VERSION_KEY, '1');
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(merged));
    if (partialOrFull.grokTranscriptionApiKey !== undefined) {
      localStorage.setItem(
        'kite_grok_transcription_api_key',
        (merged.grokTranscriptionApiKey ?? '').trim()
      );
    }

    if (typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)) {
      const saveCred = (provider: string, nextKey?: string, prevKey?: string) => {
        if (nextKey === undefined) return;
        const trimmedNext = nextKey.trim();
        const trimmedPrev = (prevKey ?? '').trim();
        if (trimmedNext.length > 0 || (trimmedPrev.length > 0 && trimmedNext.length === 0)) {
          void invokeCommand('save_provider_credential', { provider, key: trimmedNext }).catch(() => undefined);
        }
      };
      saveCred('opencode', partialOrFull.opencodeApiKey, current.opencodeApiKey);
      saveCred('grok', partialOrFull.grokApiKey, current.grokApiKey);
      saveCred('grok_transcription', partialOrFull.grokTranscriptionApiKey, current.grokTranscriptionApiKey);
      saveCred('vercel', partialOrFull.vercelApiKey, current.vercelApiKey);
      saveCred('cloudflare', partialOrFull.cloudflareApiToken, current.cloudflareApiToken);
      saveCred('cloudflare_account_id', partialOrFull.cloudflareAccountId, current.cloudflareAccountId);
      saveCred('elevenlabs', partialOrFull.elevenlabsApiKey, current.elevenlabsApiKey);

      const settingsSnapshot = {
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
      void invokeCommand('save_provider_credential', {
        provider: 'operator_settings_json',
        key: JSON.stringify(settingsSnapshot),
      }).catch(() => undefined);
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kite:operator-config-updated', { detail: merged }));
      window.dispatchEvent(new CustomEvent('kite:operator-config-changed', { detail: merged }));
    }
  } catch {
    // ignore storage errors
  }
  return merged;
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
  const isTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);
  if (!isTauri) return loadOperatorConfig();

  try {
    const hadStoredConfig = Boolean(
      localStorage.getItem(CONFIG_STORAGE_KEY) || localStorage.getItem(LEGACY_CONFIG_STORAGE_KEY)
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

    const extraGrokTrans = localStorage.getItem('kite_grok_transcription_api_key');
    if (extraGrokTrans && !records['grok_transcription']) {
      records['grok_transcription'] = extraGrokTrans;
    }

    if (Object.keys(records).length > 0) {
      await invokeCommand('migrate_localstorage_credentials', { records }).catch(() => undefined);
    }

    const hydratedPatch: Partial<OperatorProviderConfig> = {};

    if (!hadStoredConfig) {
      const snapRes = await invokeCommand<{ success?: boolean; key?: string | null }>(
        'get_active_provider_key',
        { provider: 'operator_settings_json' }
      ).catch(() => null);
      if (snapRes?.key && typeof snapRes.key === 'string') {
        try {
          const parsedSnap = JSON.parse(snapRes.key) as Partial<OperatorProviderConfig>;
          if (parsedSnap && typeof parsedSnap === 'object') {
            Object.assign(hydratedPatch, parsedSnap);
          }
        } catch {
          // ignore invalid json
        }
      }
    }

    const vaultFieldMap: Array<{ provider: string; field: keyof OperatorProviderConfig }> = [
      { provider: 'opencode', field: 'opencodeApiKey' },
      { provider: 'grok', field: 'grokApiKey' },
      { provider: 'grok_transcription', field: 'grokTranscriptionApiKey' },
      { provider: 'vercel', field: 'vercelApiKey' },
      { provider: 'cloudflare', field: 'cloudflareApiToken' },
      { provider: 'cloudflare_account_id', field: 'cloudflareAccountId' },
      { provider: 'elevenlabs', field: 'elevenlabsApiKey' },
    ];

    for (const { provider, field } of vaultFieldMap) {
      const currentVal = (cfg[field] as string | undefined)?.trim() || '';
      if (!currentVal) {
        const res = await invokeCommand<{ success?: boolean; key?: string | null }>(
          'get_active_provider_key',
          { provider }
        ).catch(() => null);
        const vaultKey = typeof res?.key === 'string' ? res.key.trim() : '';
        if (vaultKey.length > 0) {
          (hydratedPatch as any)[field] = vaultKey;
          if (provider === 'grok_transcription') {
            try {
              localStorage.setItem('kite_grok_transcription_api_key', vaultKey);
            } catch {}
          }
          if (provider === 'elevenlabs' && !hadStoredConfig && !hydratedPatch.ttsEngine) {
            hydratedPatch.ttsEngine = 'elevenlabs';
          }
        }
      }
    }

    if (Object.keys(hydratedPatch).length > 0) {
      const latest = loadOperatorConfig();
      const merged: OperatorProviderConfig = {
        ...latest,
        ...hydratedPatch,
        persona: {
          ...latest.persona,
          ...(hydratedPatch.persona ?? {}),
        },
      };
      localStorage.setItem(SEED_VERSION_KEY, '1');
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(merged));
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('kite:operator-config-updated', { detail: merged }));
        window.dispatchEvent(new CustomEvent('kite:operator-config-changed', { detail: merged }));
      }
      return merged;
    }
  } catch {
    // ignore migration errors
  }
  return loadOperatorConfig();
}

if (typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)) {
  void syncNativeCredentialsWithVault();
}
