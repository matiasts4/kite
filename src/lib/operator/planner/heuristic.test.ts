import { describe, it, expect } from 'vitest';
import { planTurnHeuristic, parseOperatorIntent } from './heuristic';
import utterances from '../fixtures/utterances.es.json';

describe('Heuristic Planner — Fixtures & Utterances', () => {
  it(`runs all ${utterances.length} test cases in utterances.es.json`, () => {
    for (const testCase of utterances) {
      const plan = planTurnHeuristic(testCase.input);

      if ((testCase as any).expectNegative) {
        expect(
          plan.actions,
          `Expected negative match for: "${testCase.input}" (id: ${testCase.id})`
        ).toHaveLength(0);
      } else {
        expect(
          plan.actions.length,
          `Expected actions for: "${testCase.input}" (id: ${testCase.id})`
        ).toBeGreaterThanOrEqual(1);

        const primaryAction = plan.actions[0];
        const expected = (testCase as any).expected;

        expect(primaryAction.type).toBe(expected.type);

        if (expected.count !== undefined) {
          expect((primaryAction as any).count).toBe(expected.count);
        }
        if (expected.engine !== undefined) {
          expect((primaryAction as any).engine).toBe(expected.engine);
        }
        if (expected.target !== undefined) {
          expect(String((primaryAction as any).target).toLowerCase()).toBe(
            String(expected.target).toLowerCase()
          );
        }
        if (expected.url !== undefined) {
          expect((primaryAction as any).url).toBe(expected.url);
        }
        if (expected.prompts !== undefined) {
          expect((primaryAction as any).prompts).toEqual(expected.prompts);
        }
      }
    }
  });

  it('keeps full backward compatibility with legacy parseOperatorIntent', () => {
    const res = parseOperatorIntent('abriera dos. Terminales, en ellas abrirá Grok y ejecute los test');
    expect(res.kind).toBe('SPAWN_TERMINALS');
    expect(res.count).toBe(2);
    expect(res.engine).toBe('grok');
    expect(res.prompt).toBe('ejecute los test');
  });

  it('parses queries about specific agents by name', () => {
    const plan1 = planTurnHeuristic('¿Qué está haciendo Nova?');
    expect(plan1.actions).toHaveLength(1);
    expect(plan1.actions[0].type).toBe('narrate_summary');
    expect((plan1.actions[0] as any).target).toBe('Nova');
    expect(plan1.reply).toContain('Nova');

    const plan2 = planTurnHeuristic('¿Cómo va el agente Orion?');
    expect(plan2.actions).toHaveLength(1);
    expect(plan2.actions[0].type).toBe('narrate_summary');
    expect((plan2.actions[0] as any).target).toBe('Orion');

    const plan3 = planTurnHeuristic('estado de Atlas');
    expect(plan3.actions).toHaveLength(1);
    expect(plan3.actions[0].type).toBe('narrate_summary');
    expect((plan3.actions[0] as any).target).toBe('Atlas');
  });

  it('parses close requests targeting agents by name', () => {
    const plan1 = planTurnHeuristic('Sierra Nova');
    expect(plan1.actions).toHaveLength(1);
    expect(plan1.actions[0].type).toBe('close_terminals');
    expect((plan1.actions[0] as any).target).toBe('Nova');
    expect(plan1.reply).toContain('Nova');

    const plan2 = planTurnHeuristic('cierra al agente Orion');
    expect(plan2.actions).toHaveLength(1);
    expect(plan2.actions[0].type).toBe('close_terminals');
    expect((plan2.actions[0] as any).target).toBe('Orion');
    expect(plan2.reply).toContain('Orion');
  });

  it('correctly detects anti-gravity and splits compound multi-agent tasks', () => {
    const input =
      'Abre dos agentes de anti-gravity, uno para quitar lo que sería la hora. Ya no quiero que aparezca la hora, simplemente logo porcentaje. El otro agente tiene que estar enfocado en el componente de el consumo, ya que quiero cambiar el icono para que sea un poco más lindo';
    const plan = planTurnHeuristic(input);

    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0] as any;
    expect(action.type).toBe('open_terminals');
    expect(action.count).toBe(2);
    expect(action.engine).toBe('antigravity');
    expect(action.prompts).toHaveLength(2);
    expect(action.prompts[0]).toContain('quitar lo que sería la hora');
    expect(action.prompts[1]).toContain('el consumo');
  });

  it('detects requests targeting the already open terminal and uses inject_prompt instead of opening new terminal', () => {
    const input1 = 'la terminal que yo tenía abierta. En esa terminal abriera The Gravity.';
    const plan1 = planTurnHeuristic(input1);
    expect(plan1.actions).toHaveLength(1);
    expect(plan1.actions[0].type).toBe('inject_prompt');
    expect((plan1.actions[0] as any).target).toBe('active');
    expect((plan1.actions[0] as any).prompt).toBe('agy');

    const input2 = 'en la terminal que tengo abierta abre Claude';
    const plan2 = planTurnHeuristic(input2);
    expect(plan2.actions).toHaveLength(1);
    expect(plan2.actions[0].type).toBe('inject_prompt');
    expect((plan2.actions[0] as any).target).toBe('active');
    expect((plan2.actions[0] as any).prompt).toBe('claude');

    const input3 = 'en esa terminal corre npm test';
    const plan3 = planTurnHeuristic(input3);
    expect(plan3.actions).toHaveLength(1);
    expect(plan3.actions[0].type).toBe('inject_prompt');
    expect((plan3.actions[0] as any).target).toBe('active');
    expect((plan3.actions[0] as any).prompt).toBe('npm test');
  });

  it('narrates terminal content instead of injecting when user asks what was in esa terminal', () => {
    const commentPhrase =
      'coméntame en pocas palabras qué es lo que había en esa terminal';
    const intent = parseOperatorIntent(commentPhrase);
    expect(intent.kind).not.toBe('INJECT_PROMPT');
    expect(intent.kind).toBe('SUMMARIZE_AND_SPEAK');
    expect(intent.target).toBe('active');

    const plan = planTurnHeuristic(commentPhrase);
    expect(plan.actions[0].type).toBe('narrate_summary');
    expect((plan.actions[0] as any).target).toBe('active');
  });

  it('inject into esa terminal includes engine command, not empty default', () => {
    const plan = planTurnHeuristic('en esa terminal abre grok');
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe('inject_prompt');
    expect((plan.actions[0] as any).target).toBe('active');
    expect((plan.actions[0] as any).prompt).toMatch(/grok/i);
  });
});
