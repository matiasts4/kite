/**
 * Manages persistence of chosen model, provider, and agent per provider across app restarts and navigation.
 */

const STORAGE_KEY_MODELS = 'kite_last_selected_models';
const STORAGE_KEY_PROVIDER = 'kite_last_selected_provider';
const STORAGE_KEY_AGENTS = 'kite_last_selected_agents';

export function getSavedSelectedModel(provider: string): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_MODELS);
    if (!raw) return null;
    const map = JSON.parse(raw);
    return typeof map[provider] === 'string' ? map[provider] : null;
  } catch {
    return null;
  }
}

export function saveSelectedModel(provider: string, model: string | null): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_MODELS);
    const map = raw ? JSON.parse(raw) : {};
    if (model) {
      map[provider] = model;
    } else {
      delete map[provider];
    }
    localStorage.setItem(STORAGE_KEY_MODELS, JSON.stringify(map));
  } catch {
    // Ignore storage quota/security errors
  }
}

export function getSavedSelectedProvider(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY_PROVIDER);
  } catch {
    return null;
  }
}

export function saveSelectedProvider(provider: string): void {
  try {
    localStorage.setItem(STORAGE_KEY_PROVIDER, provider);
  } catch {
    // Ignore
  }
}

export function getSavedSelectedAgent(provider: string): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_AGENTS);
    if (!raw) return null;
    const map = JSON.parse(raw);
    return typeof map[provider] === 'string' ? map[provider] : null;
  } catch {
    return null;
  }
}

export function saveSelectedAgent(provider: string, agent: string | null): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_AGENTS);
    const map = raw ? JSON.parse(raw) : {};
    if (agent) {
      map[provider] = agent;
    } else {
      delete map[provider];
    }
    localStorage.setItem(STORAGE_KEY_AGENTS, JSON.stringify(map));
  } catch {
    // Ignore
  }
}
