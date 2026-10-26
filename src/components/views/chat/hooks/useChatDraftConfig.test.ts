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

  it('remembers and restores the saved model and agent when switching between providers', () => {
    // 1. User picks model and agent on opencode
    const opencodeDraft = applyDraftPatch(
      { provider: 'opencode', mode: 'fullAccess', model: null, effort: null },
      { model: 'deepseek-chat', agent: 'gentle-orchestrator' }
    );
    expect(opencodeDraft.model).toBe('deepseek-chat');
    expect(opencodeDraft.agent).toBe('gentle-orchestrator');

    // 2. User switches to antigravity
    const agyDraft = applyDraftPatch(opencodeDraft, { provider: 'antigravity', model: 'gemini-2.5-pro' });
    expect(agyDraft.provider).toBe('antigravity');
    expect(agyDraft.model).toBe('gemini-2.5-pro');

    // 3. User switches back to opencode without specifying a model -> saved model and agent are restored!
    const restored = applyDraftPatch(agyDraft, { provider: 'opencode' });
    expect(restored.provider).toBe('opencode');
    expect(restored.model).toBe('deepseek-chat');
    expect(restored.agent).toBe('gentle-orchestrator');
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
