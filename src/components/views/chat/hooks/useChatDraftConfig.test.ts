import { describe, expect, it } from 'vitest';
import {
  applyDraftPatch,
  createDraftConfig,
  draftThreadRequest,
  type ChatDraftConfig,
} from './useChatDraftConfig';

const draftWithModel = (): ChatDraftConfig => ({
  provider: 'antigravity',
  mode: 'acceptEdits',
  model: 'gemini-4-argon',
  effort: 'high',
});

describe('createDraftConfig', () => {
  it('starts on the agent default provider with acceptEdits and Automatic model', () => {
    expect(createDraftConfig('codex')).toEqual({
      provider: 'codex',
      mode: 'acceptEdits',
      model: null,
      effort: null,
    });
  });

  it('starts with the agent default model when one is configured', () => {
    expect(createDraftConfig('antigravity', 'gemini-4-argon')).toEqual({
      provider: 'antigravity',
      mode: 'acceptEdits',
      model: 'gemini-4-argon',
      effort: null,
    });
  });

  it('starts with Automatic when the agent has no default model', () => {
    expect(createDraftConfig('antigravity', null).model).toBeNull();
  });
});

describe('applyDraftPatch', () => {
  it('resets the model to Automatic when the provider changes without a model', () => {
    const next = applyDraftPatch(draftWithModel(), { provider: 'claude' });

    expect(next).toEqual({
      provider: 'claude',
      mode: 'acceptEdits',
      model: null,
      effort: 'high',
    });
  });

  it('keeps an explicit model when the provider changes', () => {
    const next = applyDraftPatch(draftWithModel(), {
      provider: 'claude',
      model: 'sonnet',
    });

    expect(next.provider).toBe('claude');
    expect(next.model).toBe('sonnet');
  });

  it('keeps an explicit Automatic model when the provider changes', () => {
    const next = applyDraftPatch(draftWithModel(), {
      provider: 'claude',
      model: null,
    });

    expect(next.model).toBeNull();
  });

  it('keeps a same-provider model change', () => {
    const next = applyDraftPatch(draftWithModel(), {
      model: 'claude-opus-5-5',
    });

    expect(next.provider).toBe('antigravity');
    expect(next.model).toBe('claude-opus-5-5');
  });

  it('applies mode and effort changes without touching the model', () => {
    const next = applyDraftPatch(draftWithModel(), {
      mode: 'fullAccess',
      effort: 'low',
    });

    expect(next).toEqual({
      provider: 'antigravity',
      mode: 'fullAccess',
      model: 'gemini-4-argon',
      effort: 'low',
    });
  });
});

describe('draftThreadRequest', () => {
  it('creates the thread from the draft provider and model, not the agent engine', () => {
    const draft: ChatDraftConfig = {
      provider: 'claude',
      mode: 'fullAccess',
      model: 'sonnet',
      effort: null,
    };

    expect(draftThreadRequest(draft, 'agent-1')).toEqual({
      agentId: 'agent-1',
      provider: 'claude',
      mode: 'fullAccess',
      model: 'sonnet',
    });
  });

  it('omits the agent scope for a general chat', () => {
    const draft: ChatDraftConfig = {
      provider: 'codex',
      mode: 'acceptEdits',
      model: null,
      effort: null,
    };

    expect(draftThreadRequest(draft, null)).toEqual({
      provider: 'codex',
      mode: 'acceptEdits',
      model: null,
    });
  });
});
