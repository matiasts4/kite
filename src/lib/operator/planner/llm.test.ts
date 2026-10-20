// Kite Code — Level C Tests: LLM Planner with Mock Provider
// Validates C1 through C6:
// C1: Valid JSON output parses into OperatorPlan identically
// C2: Markdown code-fenced JSON output parses cleanly
// C3: Invalid JSON output triggers 1-shot retry and falls back to heuristic if retry fails
// C4: Prompt echo output is detected and rejected without echo leakage, falling back to heuristic
// C5: Provider timeout falls back to heuristic with fallbackReason
// C6: Out-of-schema actions (e.g. unknown action type) rejected by Zod and triggers retry

import { describe, it, expect } from 'vitest';
import { planTurnLLM } from './llm';
import type { PlannerProvider, ProviderMessage, PlannerProviderResult } from '../providers/types';

class MockPlannerProvider implements PlannerProvider {
  public id = 'mock-provider';
  public calls: ProviderMessage[][] = [];
  public responses: (PlannerProviderResult | Error)[] = [];

  constructor(responses: (PlannerProviderResult | Error)[] = []) {
    this.responses = [...responses];
  }

  async plan(messages: ProviderMessage[]): Promise<PlannerProviderResult> {
    this.calls.push(messages);
    const next = this.responses.shift();
    if (!next) {
      return {
        rawText: JSON.stringify({ reply: 'Respuesta por defecto', actions: [] }),
        latencyMs: 10,
        model: 'mock-model-v1',
      };
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

describe('Level C: LLM Planner (planTurnLLM)', () => {
  it('C1: Valid JSON output parses into identical OperatorPlan', async () => {
    const validJson = JSON.stringify({
      reply: 'Abriendo dos terminales con Grok para ejecutar pruebas.',
      actions: [
        {
          type: 'open_terminals',
          count: 2,
          engine: 'grok',
          prompts: ['correr los tests'],
        },
      ],
    });

    const mock = new MockPlannerProvider([
      { rawText: validJson, latencyMs: 45, model: 'gpt-4o-mini' },
    ]);

    const plan = await planTurnLLM('abrí dos terminales con grok y corre los tests', mock);

    expect(mock.calls.length).toBe(1);
    expect(plan.strategy).toBe('llm');
    expect(plan.reply).toBe('Abriendo dos terminales con Grok para ejecutar pruebas.');
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toEqual({
      type: 'open_terminals',
      count: 2,
      engine: 'grok',
      prompts: ['correr los tests'],
    });
  });

  it('C2: Markdown code-fenced JSON output parses cleanly', async () => {
    const fencedJson =
      '```json\n{\n  "reply": "Cerrando la terminal activa.",\n  "actions": [\n    { "type": "close_terminals", "target": "active" }\n  ]\n}\n```';

    const mock = new MockPlannerProvider([
      { rawText: fencedJson, latencyMs: 50, model: 'claude-3-5-sonnet' },
    ]);

    const plan = await planTurnLLM('cierra la terminal activa', mock);

    expect(mock.calls.length).toBe(1);
    expect(plan.strategy).toBe('llm');
    expect(plan.reply).toBe('Cerrando la terminal activa.');
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toEqual({
      type: 'close_terminals',
      target: 'active',
    });
  });

  it('C3: Invalid JSON output triggers 1-shot retry and succeeds on valid correction', async () => {
    const invalidFirst = 'Aquí tienes el plan:\n{ reply: "broken json without quotes", actions: [ ';
    const validSecond = JSON.stringify({
      reply: 'Abriendo el navegador en Google.',
      actions: [{ type: 'open_browser', url: 'https://google.com' }],
    });

    const mock = new MockPlannerProvider([
      { rawText: invalidFirst, latencyMs: 40, model: 'test-model' },
      { rawText: validSecond, latencyMs: 35, model: 'test-model' },
    ]);

    const plan = await planTurnLLM('abrir google en el navegador', mock);

    expect(mock.calls.length).toBe(2);
    // Second call should have correction instruction
    const secondCall = mock.calls[1];
    expect(secondCall[secondCall.length - 1].content).toContain('esquema JSON');
    expect(plan.strategy).toBe('llm');
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe('open_browser');
  });

  it('C3-fallback: Invalid JSON triggers retry and falls back to heuristic if retry also fails', async () => {
    const mock = new MockPlannerProvider([
      { rawText: 'No sé qué formato devolver', latencyMs: 30, model: 'test-model' },
      { rawText: 'Sigo sin poder dar JSON', latencyMs: 30, model: 'test-model' },
    ]);

    const plan = await planTurnLLM('abrir 2 terminales', mock);

    expect(mock.calls.length).toBe(2);
    expect(plan.strategy).toBe('heuristic-fallback');
    expect(plan.fallbackReason).toBeDefined();
    // Heuristic parses 'abrir 2 terminales' successfully
    expect(plan.actions.length).toBeGreaterThan(0);
    expect(plan.actions[0].type).toBe('open_terminals');
  });

  it('C4: Prompt echo output is detected and rejected without echo leakage, falling back to heuristic', async () => {
    const systemPromptLeak =
      'Eres el Operador de Kite Code. Tu rol es orquestar la interfaz. Acciones disponibles: open_terminals, close_terminals. Responde únicamente con JSON.';

    const mock = new MockPlannerProvider([
      { rawText: systemPromptLeak, latencyMs: 25, model: 'leaky-model' },
      { rawText: systemPromptLeak, latencyMs: 25, model: 'leaky-model' },
    ]);

    const plan = await planTurnLLM('abrir dos terminales', mock);

    expect(plan.strategy).toBe('heuristic-fallback');
    // Reply must not contain the leaked system prompt
    expect(plan.reply).not.toContain('Eres el Operador de Kite Code');
    expect(plan.actions.length).toBeGreaterThan(0);
  });

  it('C5: Provider timeout falls back to heuristic with fallbackReason', async () => {
    const mock = new MockPlannerProvider([new Error('timeout')]);

    const plan = await planTurnLLM('cerrar terminal activa', mock);

    expect(mock.calls.length).toBe(1);
    expect(plan.strategy).toBe('heuristic-fallback');
    expect(plan.fallbackReason).toBe('timeout');
    expect(plan.actions[0].type).toBe('close_terminals');
  });

  it('C6: Out-of-schema actions rejected by Zod and triggers retry', async () => {
    const unknownActionFirst = JSON.stringify({
      reply: 'Teletransportando al usuario...',
      actions: [{ type: 'teleport_user', destination: 'moon' }],
    });

    const validCorrection = JSON.stringify({
      reply: 'Abriendo una terminal con Claude.',
      actions: [{ type: 'open_terminals', count: 1, engine: 'claude' }],
    });

    const mock = new MockPlannerProvider([
      { rawText: unknownActionFirst, latencyMs: 20, model: 'test-model' },
      { rawText: validCorrection, latencyMs: 25, model: 'test-model' },
    ]);

    const plan = await planTurnLLM('abrir una terminal con claude', mock);

    expect(mock.calls.length).toBe(2);
    expect(plan.strategy).toBe('llm');
    expect(plan.actions[0].type).toBe('open_terminals');
  });
});
