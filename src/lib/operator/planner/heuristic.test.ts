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

  it('closes all terminals when user says cierra las terminales', () => {
    const plan = planTurnHeuristic('cierra las terminales');
    expect(plan.actions[0].type).toBe('close_terminals');
    expect((plan.actions[0] as any).target).toBe('all');
  });

  it('narrates a named agent when user asks what Nova said', () => {
    const plan = planTurnHeuristic('resume qué dijo Nova');
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe('narrate_summary');
    expect((plan.actions[0] as any).target).toBe('Nova');
  });

  it('injects into Orion when user names the agent terminal', () => {
    const plan = planTurnHeuristic(
      'en la terminal de Orion escribe: lista los archivos de src/lib'
    );
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe('inject_prompt');
    expect((plan.actions[0] as any).target).toBe('Orion');
    expect((plan.actions[0] as any).prompt).toMatch(/lista los archivos/i);
  });

  it('treats resumir la tarea as narrate, not open grok terminal', () => {
    const plan = planTurnHeuristic('resumir la tarea en la terminal abierta');
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe('narrate_summary');
    expect(plan.actions[0].type).not.toBe('open_terminals');
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

  it('defaults to powershell for generic terminals, and grok only for explicit agents without a provider', () => {
    const plan1 = planTurnHeuristic('Abre dos terminales');
    expect(plan1.actions).toHaveLength(1);
    expect(plan1.actions[0].type).toBe('open_terminals');
    expect((plan1.actions[0] as any).engine).toBe('powershell');
    expect((plan1.actions[0] as any).count).toBe(2);

    const plan2 = planTurnHeuristic('Abre dos agentes');
    expect(plan2.actions).toHaveLength(1);
    expect(plan2.actions[0].type).toBe('open_terminals');
    expect((plan2.actions[0] as any).engine).toBe('grok');
    expect((plan2.actions[0] as any).count).toBe(2);

    const plan3 = planTurnHeuristic('abre una terminal y ejecuta git status');
    expect(plan3.actions).toHaveLength(1);
    expect(plan3.actions[0].type).toBe('open_terminals');
    expect((plan3.actions[0] as any).engine).toBe('powershell');
    expect((plan3.actions[0] as any).prompts).toEqual(['git status']);
  });

  it('correctly parses quantifiers and engines for close_terminals', () => {
    const plan1 = planTurnHeuristic('Cierra una de las terminales de anti-gravity');
    expect(plan1.actions).toHaveLength(1);
    expect(plan1.actions[0].type).toBe('close_terminals');
    expect((plan1.actions[0] as any).target).toBe('antigravity');
    expect((plan1.actions[0] as any).count).toBe(1);
    expect(plan1.reply).toContain('una terminal de antigravity');

    const plan2 = planTurnHeuristic('Cierra 2 terminales de grok');
    expect(plan2.actions).toHaveLength(1);
    expect(plan2.actions[0].type).toBe('close_terminals');
    expect((plan2.actions[0] as any).target).toBe('grok');
    expect((plan2.actions[0] as any).count).toBe(2);
    expect(plan2.reply).toContain('2 terminales de grok');
  });

  it('correctly handles subjunctive cierres and abiertas phrases', () => {
    const plan1 = planTurnHeuristic('Quiero que cierres las dos terminales que están abiertas actualmente');
    expect(plan1.actions).toHaveLength(1);
    expect(plan1.actions[0].type).toBe('close_terminals');
    expect((plan1.actions[0] as any).target).toBe('all');
    expect((plan1.actions[0] as any).count).toBe(2);

    const plan2 = planTurnHeuristic('Quiero que cierres el agente Atlas');
    expect(plan2.actions).toHaveLength(1);
    expect(plan2.actions[0].type).toBe('close_terminals');
    expect((plan2.actions[0] as any).target).toBe('Atlas');

    const plan3 = planTurnHeuristic('cierra las terminales abiertas');
    expect(plan3.actions).toHaveLength(1);
    expect(plan3.actions[0].type).toBe('close_terminals');
    expect((plan3.actions[0] as any).target).toBe('all');
  });

  it('does not spawn terminal when user asks count question with lanzados', () => {
    const plan = planTurnHeuristic('¿Cuántos agentes hay lanzados actualmente?');
    expect(plan.actions.find((a) => a.type === 'open_terminals')).toBeUndefined();
  });

  it('correctly parses compound terminal targets (e.g. terminal 1 y 2)', () => {
    const plan1 = planTurnHeuristic('Quiero que cierres la terminal uno y dos');
    expect(plan1.actions).toHaveLength(1);
    expect(plan1.actions[0].type).toBe('close_terminals');
    expect((plan1.actions[0] as any).target).toBe('1, 2');
    expect(plan1.reply).toContain('las terminales 1 y 2');

    const plan2 = planTurnHeuristic('cierra las terminales 1 y 2');
    expect(plan2.actions).toHaveLength(1);
    expect(plan2.actions[0].type).toBe('close_terminals');
    expect((plan2.actions[0] as any).target).toBe('1, 2');

    const plan3 = planTurnHeuristic('Quiero que cierres las dos terminales que están vacías, que es la terminal uno y dos');
    expect(plan3.actions).toHaveLength(1);
    expect(plan3.actions[0].type).toBe('close_terminals');
    expect((plan3.actions[0] as any).target).toBe('1, 2');

    const plan4 = planTurnHeuristic('cierra las dos terminales vacías');
    expect(plan4.actions).toHaveLength(1);
    expect(plan4.actions[0].type).toBe('close_terminals');
    expect((plan4.actions[0] as any).target).toBe('idle');
    expect((plan4.actions[0] as any).count).toBe(2);
  });
});

describe('T4 / S3 — terminal default decontamination', () => {
  it('opens plain terminals with powershell instead of grok', () => {
    const plan = planTurnHeuristic('abre dos terminales');
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe('open_terminals');
    expect((plan.actions[0] as any).engine).toBe('powershell');
    expect((plan.actions[0] as any).count).toBe(2);
  });

  it('keeps shell commands on powershell instead of forcing grok', () => {
    const plan = planTurnHeuristic('abre una terminal y ejecuta git status');
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe('open_terminals');
    expect((plan.actions[0] as any).engine).toBe('powershell');
    expect((plan.actions[0] as any).prompts).toEqual(['git status']);
  });

  it('ignores providers mentioned inside the task clause', () => {
    const plan = planTurnHeuristic('abre dos terminales para revisar el bug de claude');
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe('open_terminals');
    expect((plan.actions[0] as any).engine).toBe('powershell');
    expect((plan.actions[0] as any).count).toBe(2);
    expect((plan.actions[0] as any).prompts[0]).toContain('revisar el bug de claude');
  });

  it('still honors a provider named in the open clause', () => {
    const plan = planTurnHeuristic('abre dos terminales con claude');
    expect(plan.actions).toHaveLength(1);
    expect((plan.actions[0] as any).engine).toBe('claude');
  });
});

describe('T4 / S4 — polarity, subordinate clauses and object nouns', () => {
  it('blocks negated close imperatives', () => {
    const plan = planTurnHeuristic('no cierres las terminales');
    expect(plan.actions).toHaveLength(0);
  });

  it('blocks negated open imperatives', () => {
    const plan = planTurnHeuristic('no abras dos terminales');
    expect(plan.actions).toHaveLength(0);
  });

  it('classifies by the main clause when cerrar only lives in a purpose clause', () => {
    const plan = planTurnHeuristic('abre una terminal para cerrar los issues');
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe('open_terminals');
    expect(plan.actions.some((action) => action.type === 'close_terminals')).toBe(false);
  });

  it('does not map non-terminal UI nouns with numbers onto agent terminals', () => {
    expect(planTurnHeuristic('cierra la pestaña 2').actions).toHaveLength(0);
    expect(planTurnHeuristic('cierra el tab 2').actions).toHaveLength(0);
  });

  it('still closes a numbered terminal when the terminal noun is present', () => {
    const plan = planTurnHeuristic('cierra la terminal 2');
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe('close_terminals');
    expect((plan.actions[0] as any).target).toBe('2');
  });
});

describe('T4 / S7 — multi-agent ODD handoff', () => {
  it('hands off an ODD from a named terminal to a new agent of the requested provider', () => {
    const plan = planTurnHeuristic(
      'pásale el ODD de la terminal llamada Orion a otro agente que abrirás de opencode'
    );
    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0] as any;
    expect(action.type).toBe('handoff_to_agent');
    expect(action.sourceTarget).toBe('orion');
    expect(action.targetEngine).toBe('opencode');
    expect(action.spawnNew).toBe(true);
    expect(action.artifactKind).toBe('odd');
  });

  it('hands off an ODD from a numbered terminal to a new agent', () => {
    const action = planTurnHeuristic(
      'pásale el ODD de la terminal 1 a un nuevo agente de claude'
    ).actions[0] as any;
    expect(action.type).toBe('handoff_to_agent');
    expect(action.sourceTarget).toBe(1);
    expect(action.targetEngine).toBe('claude');
    expect(action.spawnNew).toBe(true);
    expect(action.artifactKind).toBe('odd');
  });

  it('hands off an ODD from an agent engine to another provider', () => {
    const action = planTurnHeuristic('entrega el ODD de antigravity a un agente de codex')
      .actions[0] as any;
    expect(action.type).toBe('handoff_to_agent');
    expect(action.sourceTarget).toBe('antigravity');
    expect(action.targetEngine).toBe('codex');
    expect(action.spawnNew).toBe(true);
    expect(action.artifactKind).toBe('odd');
  });

  it('pipes output between existing terminals without spawning a new one', () => {
    const action = planTurnHeuristic('pásale la salida de la terminal 1 a la terminal 2')
      .actions[0] as any;
    expect(action.type).toBe('handoff_to_agent');
    expect(action.sourceTarget).toBe(1);
    expect(action.targetSession).toBe(2);
    expect(action.spawnNew).toBe(false);
    expect(action.artifactKind).toBe('output');
  });
});

describe('T4 / S8 — spatial pane control', () => {
  it('equalizes every pane to the same dimensions', () => {
    const plan = planTurnHeuristic(
      'autoajusta todas las terminales para que queden de las mismas dimensiones'
    );
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe('manage_pane_layout');
    expect((plan.actions[0] as any).operation).toBe('equalize');
  });

  it('equalizes panes with short auto-adjust phrasing', () => {
    for (const input of ['autoajustar todo', 'iguala los paneles', 'ajusta el tamaño de los paneles']) {
      const plan = planTurnHeuristic(input);
      expect(plan.actions).toHaveLength(1);
      expect(plan.actions[0].type).toBe('manage_pane_layout');
      expect((plan.actions[0] as any).operation).toBe('equalize');
    }
  });

  it('splits, focuses and zooms a targeted terminal', () => {
    const horizontal = planTurnHeuristic('divide la terminal 1 horizontalmente').actions[0] as any;
    expect(horizontal.type).toBe('manage_pane_layout');
    expect(horizontal.operation).toBe('split-horizontal');
    expect(horizontal.target).toBe(1);

    const vertical = planTurnHeuristic('divide la terminal 1 verticalmente').actions[0] as any;
    expect(vertical.operation).toBe('split-vertical');

    const focus = planTurnHeuristic('haz foco en la terminal 2').actions[0] as any;
    expect(focus.operation).toBe('focus');
    expect(focus.target).toBe(2);

    const focusByEngine = planTurnHeuristic('enfoca la terminal de claude').actions[0] as any;
    expect(focusByEngine.operation).toBe('focus');
    expect(focusByEngine.target).toBe('claude');

    const zoom = planTurnHeuristic('maximiza la terminal 1').actions[0] as any;
    expect(zoom.operation).toBe('zoom');
    expect(zoom.target).toBe(1);

    const zoomVerb = planTurnHeuristic('agranda la terminal 1').actions[0] as any;
    expect(zoomVerb.operation).toBe('zoom');
  });
});

describe('T4 / S9 — workspace switching', () => {
  it('switches workspace before opening terminals requested in the same sentence', () => {
    const plan = planTurnHeuristic('cambia al proyecto backend y abre dos terminales');
    expect(plan.actions).toHaveLength(2);
    expect(plan.actions[0].type).toBe('switch_workspace');
    expect((plan.actions[0] as any).workspaceQuery).toBe('backend');
    expect(plan.actions[1].type).toBe('open_terminals');
    expect((plan.actions[1] as any).count).toBe(2);
    expect((plan.actions[1] as any).engine).toBe('powershell');
  });

  it('switches workspace and view mode in one action', () => {
    const plan = planTurnHeuristic('cambia al workspace kite y abre código');
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe('switch_workspace');
    expect((plan.actions[0] as any).workspaceQuery).toBe('kite');
    expect((plan.actions[0] as any).viewMode).toBe('code');
  });

  it('understands move-to-workspace phrasing', () => {
    const plan = planTurnHeuristic('muévete al workspace frontend');
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe('switch_workspace');
    expect((plan.actions[0] as any).workspaceQuery).toBe('frontend');

    const goTo = planTurnHeuristic('ve al proyecto atlantis');
    expect(goTo.actions).toHaveLength(1);
    expect(goTo.actions[0].type).toBe('switch_workspace');
    expect((goTo.actions[0] as any).workspaceQuery).toBe('atlantis');
  });
});
