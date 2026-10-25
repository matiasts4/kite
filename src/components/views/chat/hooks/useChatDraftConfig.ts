import type { ChatMode, ChatProvider } from '../types';
import {
  getSavedSelectedModel,
  saveSelectedModel,
  getSavedSelectedProvider,
  saveSelectedProvider,
  getSavedSelectedAgent,
  saveSelectedAgent,
} from '../modelPersistence';

/** Configuration chosen for the Agent surface before the first thread exists. */
export interface ChatDraftConfig {
  provider: ChatProvider;
  mode: ChatMode;
  model: string | null;
  effort: string | null;
  agent?: string | null;
}

export interface ChatConfigPatch {
  provider?: ChatProvider;
  mode?: ChatMode;
  model?: string | null;
  effort?: string | null;
  agent?: string | null;
}

/** Arguments that create a thread from the draft instead of the agent engine. */
export type DraftThreadRequest = {
  agentId?: string;
  provider: ChatProvider;
  mode: ChatMode;
  model: string | null;
  agent?: string | null;
};

/**
 * A draft opens on the agent's provider with edits auto-accepted and the
 * agent's configured default model; without one it checks localStorage or starts on Automatic.
 */
export function createDraftConfig(
  defaultProvider: ChatProvider,
  defaultModel: string | null = null,
  defaultAgent: string | null = null
): ChatDraftConfig {
  const savedProvider = getSavedSelectedProvider();
  const provider = (savedProvider && ['claude', 'codex', 'cursor', 'grok', 'opencode', 'antigravity', 'gemini'].includes(savedProvider)
    ? (savedProvider as ChatProvider)
    : defaultProvider);
  const savedModel = getSavedSelectedModel(provider);
  const savedAgent = defaultAgent !== null ? defaultAgent : getSavedSelectedAgent(provider);

  return {
    provider,
    mode: 'acceptEdits',
    model: defaultModel !== null ? defaultModel : savedModel,
    effort: null,
    ...(savedAgent !== null && savedAgent !== undefined ? { agent: savedAgent } : {}),
  };
}

/**
 * Applies a composer patch to the draft. A provider change without an explicit
 * model restores that provider's saved model if previously chosen, or Automatic;
 * an explicit model, including null, wins.
 */
export function applyDraftPatch(
  current: ChatDraftConfig,
  patch: ChatConfigPatch
): ChatDraftConfig {
  const provider = patch.provider ?? current.provider;
  const providerChanged = provider !== current.provider;

  if (patch.provider) {
    saveSelectedProvider(provider);
  }

  let model: string | null;
  if (patch.model !== undefined) {
    model = patch.model;
    saveSelectedModel(provider, model);
  } else if (providerChanged) {
    model = getSavedSelectedModel(provider);
  } else {
    model = current.model;
  }

  let agent: string | null | undefined;
  if (patch.agent !== undefined) {
    agent = patch.agent;
    saveSelectedAgent(provider, agent);
  } else if (providerChanged) {
    agent = getSavedSelectedAgent(provider);
  } else {
    agent = current.agent;
  }

  return {
    provider,
    mode: patch.mode ?? current.mode,
    model,
    effort: patch.effort !== undefined ? patch.effort : current.effort,
    ...(agent !== null && agent !== undefined ? { agent } : {}),
  };
}

/** Builds create-thread arguments from the draft, never from the agent engine. */
export function draftThreadRequest(
  draft: ChatDraftConfig,
  agentId?: string | null
): DraftThreadRequest {
  return {
    ...(agentId ? { agentId } : {}),
    provider: draft.provider,
    mode: draft.mode,
    model: draft.model,
    ...(draft.agent ? { agent: draft.agent } : {}),
  };
}
