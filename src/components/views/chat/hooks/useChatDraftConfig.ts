import type { AgentProfile } from '../../../../types';
import type { ChatMode, ChatProvider } from '../types';
import {
  getSavedSelectedModel,
  saveSelectedModel,
  getSavedSelectedProvider,
  saveSelectedProvider,
  getSavedSelectedAgent,
  getSavedSelectedEffort,
  saveSelectedAgent,
  saveSelectedEffort,
} from '../modelPersistence';

/** Configuration chosen for the Agent surface before the first thread exists. */
export interface ChatDraftConfig {
  provider: ChatProvider;
  mode: ChatMode;
  model: string | null;
  effort: string | null;
  agent?: string | null;
  plan?: boolean;
}

export interface ChatConfigPatch {
  provider?: ChatProvider;
  mode?: ChatMode;
  model?: string | null;
  effort?: string | null;
  agent?: string | null;
  plan?: boolean;
}

/** Arguments that create a thread from the draft instead of the agent engine. */
export type DraftThreadRequest = {
  agentId?: string;
  provider: ChatProvider;
  mode: ChatMode;
  model: string | null;
  effort: string | null;
  agent?: string | null;
  plan?: boolean;
  workspaceId?: string | null;
};

export interface CreateDraftConfigOptions {
  defaultMode?: ChatMode | string | null;
  defaultPlan?: boolean | string | null;
  defaultEffort?: string | null;
  defaultProviderOptions?: Array<{ provider?: string; effort?: string | null; [key: string]: unknown }> | null;
  defaultModel?: string | null;
  agentProfile?: Partial<AgentProfile> | null;
}

/**
 * A draft opens on the agent's provider with full access and the
 * agent's configured default model; without one it checks localStorage or starts on Automatic.
 */
export function createDraftConfig(
  defaultProvider: ChatProvider,
  defaultModel: string | null = null,
  defaultAgent: string | null = null,
  options?: CreateDraftConfigOptions | Partial<AgentProfile> | null
): ChatDraftConfig {
  const savedProvider = getSavedSelectedProvider();
  const provider = (savedProvider && ['claude', 'codex', 'cursor', 'grok', 'opencode', 'antigravity', 'gemini'].includes(savedProvider)
    ? (savedProvider as ChatProvider)
    : defaultProvider);

  const candidateModel =
    defaultModel !== null
      ? defaultModel
      : (options?.defaultModel ?? (options as any)?.agentProfile?.defaultModel ?? null);
  const savedModel = candidateModel !== null ? candidateModel : getSavedSelectedModel(provider);
  const savedAgent = defaultAgent !== null ? defaultAgent : getSavedSelectedAgent(provider);

  const rawMode = options?.defaultMode ?? (options as any)?.agentProfile?.defaultMode;
  const rawPlan = options?.defaultPlan ?? (options as any)?.agentProfile?.defaultPlan;

  let mode: ChatMode = 'fullAccess';
  if (rawMode === 'fullAccess' || rawMode === 'readOnly' || rawMode === 'acceptEdits') {
    mode = rawMode;
  } else if (rawPlan === true || rawPlan === 'true') {
    mode = 'readOnly';
  }

  let plan: boolean | undefined = undefined;
  if (rawPlan !== undefined && rawPlan !== null) {
    plan = rawPlan === true || rawPlan === 'true';
  } else if (rawMode === 'readOnly') {
    plan = true;
  }

  const explicitEffort =
    options?.defaultEffort ??
    (options as any)?.agentProfile?.defaultEffort ??
    options?.defaultProviderOptions?.find((o: any) => o?.effort)?.effort ??
    (options as any)?.agentProfile?.defaultProviderOptions?.find((o: any) => o?.effort)?.effort ??
    null;

  const savedEffort = explicitEffort !== null ? explicitEffort : getSavedSelectedEffort(provider, savedModel);

  return {
    provider,
    mode,
    model: savedModel,
    effort: savedEffort,
    ...(savedAgent !== null && savedAgent !== undefined ? { agent: savedAgent } : {}),
    ...(plan !== undefined ? { plan } : {}),
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

  let mode = patch.mode ?? current.mode;
  let plan: boolean | undefined = current.plan;
  if (patch.plan !== undefined) {
    plan = patch.plan;
  } else if (current.plan !== undefined) {
    if (patch.mode === 'readOnly') {
      plan = true;
    } else if (patch.mode === 'acceptEdits' || patch.mode === 'fullAccess') {
      plan = false;
    }
  }

  return {
    provider,
    mode,
    model,
    effort: (() => {
      if (patch.effort !== undefined) {
        const nextEffort = patch.effort;
        saveSelectedEffort(provider, model, nextEffort);
        return nextEffort;
      }
      if (providerChanged || patch.model !== undefined) {
        return getSavedSelectedEffort(provider, model) ?? current.effort;
      }
      return current.effort;
    })(),
    ...(agent !== null && agent !== undefined ? { agent } : {}),
    ...(plan !== undefined ? { plan } : {}),
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
    effort: draft.effort,
    ...(draft.agent ? { agent: draft.agent } : {}),
    ...(draft.plan !== undefined ? { plan: draft.plan } : {}),
  };
}
