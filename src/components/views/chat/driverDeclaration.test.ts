import { describe, it, expect } from 'vitest';
import {
  declarationFromCatalog,
  resolveEffortChoicesForModel,
} from './driverDeclaration';
import type { ModelOption } from './types';

describe('resolveEffortChoicesForModel', () => {
  it('returns null when model is null or does not support effort', () => {
    expect(resolveEffortChoicesForModel(null)).toBeNull();
    expect(
      resolveEffortChoicesForModel({ id: 'plain-model', name: 'Plain Model', supportsEffort: false })
    ).toBeNull();
  });

  it('maps multi-tier effort variants correctly with Spanish labels', () => {
    const model: ModelOption = {
      id: 'google/antigravity-gemini-3-flash',
      name: 'Gemini 3 Flash',
      supportsEffort: true,
      effortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'xhigh',
    };

    const resolved = resolveEffortChoicesForModel(model);
    expect(resolved).not.toBeNull();
    expect(resolved!.choices).toHaveLength(6);
    expect(resolved!.choices.map((c) => c.label)).toEqual([
      'Mínimo',
      'Bajo',
      'Medio',
      'Alto',
      'Muy Alto',
      'Máximo',
    ]);
    expect(resolved!.defaultEffort).toBe('xhigh');
  });

  it('supports custom binary variants like low and max', () => {
    const model: ModelOption = {
      id: 'google/antigravity-claude-opus-4-6-thinking',
      name: 'Claude Opus Thinking',
      supportsEffort: true,
      effortLevels: ['low', 'max'],
      defaultEffort: 'max',
    };

    const resolved = resolveEffortChoicesForModel(model);
    expect(resolved).not.toBeNull();
    expect(resolved!.choices).toHaveLength(2);
    expect(resolved!.choices.map((c) => c.label)).toEqual(['Bajo', 'Máximo']);
    expect(resolved!.defaultEffort).toBe('max');
  });

  it('infers reasoning tiers when model supports effort but does not list explicit levels', () => {
    const geminiModel: ModelOption = {
      id: 'gemini-4-argon',
      name: 'Gemini 4 Argon',
      supportsEffort: true,
    };
    const resolved = resolveEffortChoicesForModel(geminiModel);
    expect(resolved).not.toBeNull();
    expect(resolved!.choices.map((c) => c.id)).toEqual(['minimal', 'low', 'medium', 'high']);

    const claudeModel: ModelOption = {
      id: 'claude-3-7-sonnet-thinking',
      name: 'Claude 3.7 Sonnet',
      supportsEffort: true,
    };
    const resolvedClaude = resolveEffortChoicesForModel(claudeModel);
    expect(resolvedClaude!.choices.map((c) => c.id)).toEqual(['low', 'medium', 'high', 'max']);
  });
});

describe('declarationFromCatalog with dynamic effort levels', () => {
  it('supplies model-specific effort levels in declaration', () => {
    const dynamicModels: ModelOption[] = [
      {
        id: 'google/antigravity-gemini-3-flash',
        name: 'Gemini 3 Flash (Antigravity)',
        supportsEffort: true,
        effortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultEffort: 'medium',
      },
      {
        id: 'google/gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        supportsEffort: false,
      },
    ];

    const decl = declarationFromCatalog({
      provider: 'opencode',
      selectedModel: 'google/antigravity-gemini-3-flash',
      dynamicModels,
    });

    expect(decl.effort).not.toBeNull();
    expect(decl.effort!.map((e) => e.id)).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(decl.defaultEffort).toBe('medium');
    expect(decl.unlistedReasons?.effort).toBeUndefined();

    // Now select non-effort model
    const nonEffortDecl = declarationFromCatalog({
      provider: 'opencode',
      selectedModel: 'google/gemini-2.5-flash',
      dynamicModels,
    });

    expect(nonEffortDecl.effort).toBeNull();
    expect(nonEffortDecl.defaultEffort).toBeNull();
    expect(nonEffortDecl.unlistedReasons?.effort).toContain('does not advertise reasoning effort');
  });
});
