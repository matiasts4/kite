import type {
  OpenCodeModelOption,
  ModelCatalogProvider,
  ModelCatalogSnapshot,
  ModelCatalogFetchResult,
} from './types';
import {
  OPENCODE_MODEL_CATALOG,
  VERCEL_MODEL_CATALOG,
  CLOUDFLARE_MODEL_CATALOG,
  OPENCODE_GO_MODELS_URL,
  normalizeOpenCodeBaseUrl,
  isOpenCodeGoChatBaseUrl,
  isOpenCodeGoChatCompatibleModel,
} from './modelCatalogs';
import { operatorHttpFetch } from './httpFetch';
import { loadOperatorConfig } from './storage';

const MODEL_CATALOG_KEYS = {
  opencode: 'kite.operator.modelCatalog.opencode.v2',
  vercel: 'kite.operator.modelCatalog.vercel.v1',
  cloudflare: 'kite.operator.modelCatalog.cloudflare.v1',
} as const;

const MAX_CACHED_MODELS = 2000;

function isModelOption(value: unknown): value is OpenCodeModelOption {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<OpenCodeModelOption>;
  return typeof row.id === 'string' && row.id.trim().length > 0 && typeof row.label === 'string';
}

export function loadModelCatalog(provider: ModelCatalogProvider): ModelCatalogSnapshot | null {
  try {
    const raw = localStorage.getItem(MODEL_CATALOG_KEYS[provider]);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { models?: unknown; savedAt?: unknown };
    if (!Array.isArray(parsed.models)) return null;
    const models = parsed.models.filter(isModelOption).slice(0, MAX_CACHED_MODELS);
    if (models.length === 0) return null;
    return {
      models,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveModelCatalog(
  provider: ModelCatalogProvider,
  models: OpenCodeModelOption[]
): ModelCatalogSnapshot {
  const snapshot: ModelCatalogSnapshot = {
    models: models.filter(isModelOption).slice(0, MAX_CACHED_MODELS),
    savedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(MODEL_CATALOG_KEYS[provider], JSON.stringify(snapshot));
  } catch {
    // The last list is still usable in memory if storage is full.
  }
  return snapshot;
}

function keptCatalog(
  provider: ModelCatalogProvider,
  fallback: OpenCodeModelOption[],
  detail: string
): ModelCatalogFetchResult {
  const cached = loadModelCatalog(provider);
  if (cached) {
    return {
      models: cached.models,
      fresh: false,
      savedAt: cached.savedAt,
      detail: `${detail} Se mantiene la última lista.`,
    };
  }
  return {
    models: fallback,
    fresh: false,
    savedAt: null,
    detail: `${detail} Mostrando la lista incluida.`,
  };
}

async function readRemoteModelList(
  url: string,
  apiKey: string
): Promise<Array<{ id: string; name?: string; description?: string }>> {
  const res = await operatorHttpFetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json();
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.result)) {
    return data.result.map((item: any) => ({
      id: item.name || item.id,
      name: item.name || item.id,
      description: item.description,
    }));
  }
  if (Array.isArray(data)) return data;
  return [];
}

export async function fetchOpenCodeModels(
  apiKey?: string,
  baseUrl?: string
): Promise<ModelCatalogFetchResult> {
  const cfg = loadOperatorConfig();
  const key = (apiKey ?? cfg.opencodeApiKey)?.trim();
  const base = normalizeOpenCodeBaseUrl(baseUrl ?? cfg.opencodeBaseUrl).replace(/\/+$/, '');

  if (!key) {
    return keptCatalog(
      'opencode',
      OPENCODE_MODEL_CATALOG,
      'Falta la API key de OpenCode.'
    );
  }

  if (isOpenCodeGoChatBaseUrl(base)) {
    return fetchOpenCodeGoModels(key);
  }

  try {
    const list = await readRemoteModelList(`${base}/models`, key);
    if (!list.length) {
      return keptCatalog(
        'opencode',
        OPENCODE_MODEL_CATALOG,
        'El catálogo de OpenCode llegó vacío.'
      );
    }

    const dynamic: OpenCodeModelOption[] = list
      .filter((m) => typeof m.id === 'string' && !m.id.endsWith('-free'))
      .map((m) => {
        const id = m.id;
        const known = OPENCODE_MODEL_CATALOG.find((k) => k.id === id);
        if (known) return known;

        const label = m.name || id;
        return {
          id,
          label: `${label} (via OpenCode)`,
          badge: id.includes('flash') || id.includes('mini') ? 'Fast' : 'Standard',
          tier: 'OpenCode Gateway',
          description: m.description || `Modelo ${id} disponible en el gateway OpenCode.`,
        };
      });

    if (!dynamic.length) {
      return keptCatalog(
        'opencode',
        OPENCODE_MODEL_CATALOG,
        'OpenCode no devolvió modelos utilizables.'
      );
    }

    const saved = saveModelCatalog('opencode', dynamic);
    return {
      models: saved.models,
      fresh: true,
      savedAt: saved.savedAt,
      detail: '',
    };
  } catch {
    return keptCatalog(
      'opencode',
      OPENCODE_MODEL_CATALOG,
      'No se pudo consultar OpenCode.'
    );
  }
}

export async function fetchOpenCodeGoModels(
  apiKey?: string
): Promise<ModelCatalogFetchResult> {
  const cfg = loadOperatorConfig();
  const key = (apiKey ?? cfg.opencodeApiKey)?.trim();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;

  try {
    const res = await operatorHttpFetch(
      OPENCODE_GO_MODELS_URL,
      { method: 'GET', headers },
      { credentialProvider: 'opencode' }
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    const list: Array<{ id?: string }> = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data)
        ? data
        : [];

    const dynamic: OpenCodeModelOption[] = list
      .filter(
        (model) =>
          typeof model?.id === 'string' && isOpenCodeGoChatCompatibleModel(model.id)
      )
      .map((model) => {
        const id = model.id as string;
        const known = OPENCODE_MODEL_CATALOG.find((entry) => entry.id === id);
        if (known) return known;

        const label = id
          .split('-')
          .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
          .join(' ');
        return {
          id,
          label: `${label} (OpenCode Go)`,
          badge: /flash|mini|lite/i.test(id)
            ? 'Fast'
            : /pro|max/i.test(id)
              ? 'Pro'
              : 'Go',
          tier: 'OpenCode Go',
          description: `Modelo ${id} incluido en la suscripción OpenCode Go.`,
        };
      });

    if (!dynamic.length) {
      return keptCatalog(
        'opencode',
        OPENCODE_MODEL_CATALOG,
        'OpenCode Go no devolvió modelos compatibles con Chat Completions.'
      );
    }

    const saved = saveModelCatalog('opencode', dynamic);
    return {
      models: saved.models,
      fresh: true,
      savedAt: saved.savedAt,
      detail: '',
    };
  } catch {
    return keptCatalog(
      'opencode',
      OPENCODE_MODEL_CATALOG,
      'No se pudo consultar el catálogo de OpenCode Go.'
    );
  }
}

export async function fetchVercelModels(
  apiKey?: string,
  baseUrl?: string
): Promise<ModelCatalogFetchResult> {
  const cfg = loadOperatorConfig();
  const key = (apiKey ?? cfg.vercelApiKey)?.trim();
  const base =
    (baseUrl ?? cfg.vercelBaseUrl)?.replace(/\/+$/, '') || 'https://ai-gateway.vercel.sh/v1';

  if (!key) {
    return keptCatalog(
      'vercel',
      VERCEL_MODEL_CATALOG,
      'Falta la API key de Vercel.'
    );
  }

  try {
    const list = await readRemoteModelList(`${base}/models`, key);
    if (!list.length) {
      return keptCatalog(
        'vercel',
        VERCEL_MODEL_CATALOG,
        'El catálogo de Vercel llegó vacío.'
      );
    }

    const dynamic: OpenCodeModelOption[] = list
      .filter((m) => typeof m.id === 'string')
      .map((m) => {
        const id = m.id;
        const known = VERCEL_MODEL_CATALOG.find((k) => k.id === id);
        if (known) return known;

        const label = m.name || id;
        return {
          id,
          label: `${label} (via Vercel AI)`,
          badge: id.includes('flash') || id.includes('mini') || id.includes('haiku') ? 'Fast' : 'Standard',
          tier: 'Vercel AI Gateway',
          description: m.description || `Modelo ${id} disponible en Vercel AI Gateway.`,
        };
      });

    if (!dynamic.length) {
      return keptCatalog(
        'vercel',
        VERCEL_MODEL_CATALOG,
        'Vercel no devolvió modelos utilizables.'
      );
    }

    const saved = saveModelCatalog('vercel', dynamic);
    return {
      models: saved.models,
      fresh: true,
      savedAt: saved.savedAt,
      detail: '',
    };
  } catch {
    return keptCatalog(
      'vercel',
      VERCEL_MODEL_CATALOG,
      'No se pudo consultar Vercel.'
    );
  }
}

export async function fetchCloudflareModels(
  apiToken?: string,
  accountId?: string,
  baseUrl?: string
): Promise<ModelCatalogFetchResult> {
  const cfg = loadOperatorConfig();
  const token = (apiToken ?? cfg.cloudflareApiToken)?.trim();
  const account = (accountId ?? cfg.cloudflareAccountId)?.trim();
  const base =
    (baseUrl ?? cfg.cloudflareBaseUrl)?.replace(/\/+$/, '') ||
    'https://api.cloudflare.com/client/v4/accounts';

  if (!token || !account) {
    return keptCatalog(
      'cloudflare',
      CLOUDFLARE_MODEL_CATALOG,
      'Falta el Account ID o API Token de Cloudflare.'
    );
  }

  try {
    let list: Array<{ id: string; name?: string; description?: string }> = [];
    try {
      list = await readRemoteModelList(`${base}/${account}/ai/v1/models`, token);
    } catch {
      list = await readRemoteModelList(
        `${base}/${account}/ai/models/search?task=Text%20Generation`,
        token
      );
    }

    if (!list.length) {
      return keptCatalog(
        'cloudflare',
        CLOUDFLARE_MODEL_CATALOG,
        'El catálogo de Cloudflare llegó vacío.'
      );
    }

    const dynamic: OpenCodeModelOption[] = list
      .filter((m) => typeof m.id === 'string')
      .map((m) => {
        const id = m.id;
        const known = CLOUDFLARE_MODEL_CATALOG.find((k) => k.id === id);
        if (known) return known;

        const label = m.name || id;
        return {
          id,
          label: `${label} (via Cloudflare)`,
          badge:
            id.includes('flash') || id.includes('8b') || id.includes('3b') || id.includes('1b')
              ? 'Fast'
              : 'Edge',
          tier: 'Cloudflare Workers AI',
          description: m.description || `Modelo ${id} disponible en Cloudflare Workers AI.`,
        };
      });

    if (!dynamic.length) {
      return keptCatalog(
        'cloudflare',
        CLOUDFLARE_MODEL_CATALOG,
        'Cloudflare no devolvió modelos utilizables.'
      );
    }

    const saved = saveModelCatalog('cloudflare', dynamic);
    return {
      models: saved.models,
      fresh: true,
      savedAt: saved.savedAt,
      detail: '',
    };
  } catch {
    return keptCatalog(
      'cloudflare',
      CLOUDFLARE_MODEL_CATALOG,
      'No se pudo consultar Cloudflare.'
    );
  }
}
