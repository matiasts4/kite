/**
 * Manages persistence of chosen model, provider, and agent per provider across app restarts and navigation.
 */

const STORAGE_KEY_MODELS = 'kite_last_selected_models';
const STORAGE_KEY_PROVIDER = 'kite_last_selected_provider';
const STORAGE_KEY_AGENTS = 'kite_last_selected_agents';
const STORAGE_KEY_EFFORT = 'kite_last_selected_effort';

const memoryStore = new Map<string, string>();

function storageGet(key: string): string | null {
  try {
    if (typeof localStorage !== 'undefined') {
      const value = localStorage.getItem(key);
      if (value !== null) return value;
    }
  } catch {
    // Node can expose a localStorage getter that throws. The memory mirror still holds the selection.
  }
  return memoryStore.get(key) ?? null;
}

function storageSet(key: string, value: string): void {
  memoryStore.set(key, value);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // The memory mirror is the selection for this session.
  }
}

export function resetRememberedSelections(): void {
  memoryStore.clear();
  try {
    if (typeof localStorage !== 'undefined') localStorage.clear();
  } catch {
    // Nothing else to clear.
  }
}

export function getSavedSelectedModel(provider: string): string | null {
  try {
    const raw = storageGet(STORAGE_KEY_MODELS);
    if (!raw) return null;
    const map = JSON.parse(raw);
    return typeof map[provider] === 'string' ? map[provider] : null;
  } catch {
    return null;
  }
}

export function saveSelectedModel(provider: string, model: string | null): void {
  try {
    const raw = storageGet(STORAGE_KEY_MODELS);
    const map = raw ? JSON.parse(raw) : {};
    if (model) {
      map[provider] = model;
    } else {
      delete map[provider];
    }
    storageSet(STORAGE_KEY_MODELS, JSON.stringify(map));
  } catch {
    // Ignore storage quota/security errors
  }
}

export function getSavedSelectedProvider(): string | null {
  try {
    return storageGet(STORAGE_KEY_PROVIDER);
  } catch {
    return null;
  }
}

export function saveSelectedProvider(provider: string): void {
  try {
    storageSet(STORAGE_KEY_PROVIDER, provider);
  } catch {
    // Ignore
  }
}

export function getSavedSelectedAgent(provider: string): string | null {
  try {
    const raw = storageGet(STORAGE_KEY_AGENTS);
    if (!raw) return null;
    const map = JSON.parse(raw);
    return typeof map[provider] === 'string' ? map[provider] : null;
  } catch {
    return null;
  }
}

function effortKey(provider: string, model: string | null): string {
  return `${provider}::${model ?? ''}`;
}

export function getSavedSelectedEffort(provider: string, model: string | null): string | null {
  try {
    const raw = storageGet(STORAGE_KEY_EFFORT);
    if (!raw) return null;
    const map = JSON.parse(raw);
    const value = map[effortKey(provider, model)];
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function saveSelectedEffort(
  provider: string,
  model: string | null,
  effort: string | null
): void {
  try {
    const raw = storageGet(STORAGE_KEY_EFFORT);
    const map = raw ? JSON.parse(raw) : {};
    const key = effortKey(provider, model);
    if (effort) {
      map[key] = effort;
    } else {
      delete map[key];
    }
    storageSet(STORAGE_KEY_EFFORT, JSON.stringify(map));
  } catch {
    // Ignore storage quota/security errors
  }
}

export function saveSelectedAgent(provider: string, agent: string | null): void {
  try {
    const raw = storageGet(STORAGE_KEY_AGENTS);
    const map = raw ? JSON.parse(raw) : {};
    if (agent) {
      map[provider] = agent;
    } else {
      delete map[provider];
    }
    storageSet(STORAGE_KEY_AGENTS, JSON.stringify(map));
  } catch {
    // Ignore
  }
}
