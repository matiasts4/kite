import type { ChatMode, ChatProvider } from '../types';

/** Configuration chosen for the Agent surface before the first thread exists. */
export interface ChatDraftConfig {
  provider: ChatProvider;
  mode: ChatMode;
  model: string | null;
  effort: string | null;
}

export interface ChatConfigPatch {
  provider?: ChatProvider;
  mode?: ChatMode;
  model?: string | null;
  effort?: string | null;
}

/** Arguments that create a thread from the draft instead of the agent engine. */
export type DraftThreadRequest = {
  agentId?: string;
  provider: ChatProvider;
  mode: ChatMode;
  model: string | null;
};

/**
 * A draft opens on the agent's provider with edits auto-accepted and the
 * agent's configured default model; without one it starts on Automatic.
 */
export function createDraftConfig(
  defaultProvider: ChatProvider,
  defaultModel: string | null = null
): ChatDraftConfig {
  return {
    provider: defaultProvider,
    mode: 'acceptEdits',
    model: defaultModel,
    effort: null,
  };
}

/**
 * Applies a composer patch to the draft. A provider change without an explicit
 * model clears the model so the previous provider's model id never follows the
 * user into the new provider; an explicit model, including null, wins.
 */
export function applyDraftPatch(
  current: ChatDraftConfig,
  patch: ChatConfigPatch
): ChatDraftConfig {
  const provider = patch.provider ?? current.provider;
  const providerChanged = provider !== current.provider;
  const model = patch.model !== undefined
    ? patch.model
    : providerChanged
      ? null
      : current.model;

  return {
    provider,
    mode: patch.mode ?? current.mode,
    model,
    effort: patch.effort !== undefined ? patch.effort : current.effort,
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
  };
}
