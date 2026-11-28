import { describe, it, expect } from 'vitest';
import {
  declarationFromCatalog,
  reconcileEffortForModel,
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

  it('maps multi-tier effort variants correctly with English labels', () => {
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
      'Minimal',
      'Low',
      'Medium',
      'High',
      'Very High',
      'Max',
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
    expect(resolved!.choices.map((c) => c.label)).toEqual(['Low', 'Max']);
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

  it('labels ultra and disables a model that advertises fewer than two levels', () => {
    const ultra = resolveEffortChoicesForModel({
      id: 'gemini-4-argon',
      name: 'Gemini 4 Argon',
      supportsEffort: true,
      effortLevels: ['low', 'ultra'],
    });
    expect(ultra!.choices.map((choice) => choice.label)).toEqual(['Low', 'Ultra']);
    expect(ultra!.choices[1]?.detail).toBe('Ultra reasoning pushed to the model ceiling');

    expect(
      resolveEffortChoicesForModel({
        id: 'solo',
        name: 'Solo',
        supportsEffort: true,
        effortLevels: ['ultra'],
      })
    ).toBeNull();
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

describe('reconcileEffortForModel', () => {
  it('clears effort for models that do not advertise reasoning effort', () => {
    expect(
      reconcileEffortForModel(
        { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)', supportsEffort: false },
        'high'
      )
    ).toBeNull();
    expect(reconcileEffortForModel(null, 'high')).toBeNull();
  });

  it('preserves supported levels and clamps out-of-range levels to the nearest advertised tier', () => {
    const argon: ModelOption = {
      id: 'gemini-4-argon',
      name: 'Gemini 4 Argon',
      supportsEffort: true,
      effortLevels: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
    };
    expect(reconcileEffortForModel(argon, 'high')).toBe('high');
    expect(reconcileEffortForModel(argon, 'xhigh')).toBe('high');
    expect(reconcileEffortForModel(argon, 'max')).toBe('high');
    expect(reconcileEffortForModel(argon, 'minimal')).toBe('low');
    expect(reconcileEffortForModel(argon, null)).toBeNull();
  });
});
