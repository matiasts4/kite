import { describe, expect, it } from 'vitest';
import { parseSpokenSummary, prepareTerminalExcerpt, summarizeTerminalsWithProvider } from './terminalSummary';
import type { PlannerProvider } from '../providers/types';

describe('terminal summary via planner provider', () => {
  it('reads the spoken field from planner JSON', () => {
    const text = parseSpokenSummary(
      '{"spoken":"El agente siguió compilando agent_inbox y no llegó a la prueba Node."}'
    );
    expect(text).toMatch(/agent_inbox/);
    expect(text).not.toMatch(/Thought for/);
  });

  it('drops thought-for lines before sending the buffer', () => {
    const excerpt = prepareTerminalExcerpt(
      'Thought for 3m 22s\nExplored 3 files\nEl cargo test de agent_inbox falló.\n'
    );
    expect(excerpt).not.toMatch(/Thought for/);
    expect(excerpt).not.toMatch(/Explored 3/);
    expect(excerpt).toMatch(/agent_inbox/);
  });

  it('asks the configured provider and returns its spoken summary', async () => {
    const provider: PlannerProvider = {
      id: 'cloudflare',
      plan: async (messages) => {
        expect(messages[0].content).toMatch(/spoken/);
        expect(messages[1].content).toMatch(/hola.md/);
        return {
          rawText: '{"spoken":"Pidió la prueba chica de hola.md y el agente se quedó compilando."}',
          latencyMs: 12,
          model: 'llama',
        };
      },
    };

    const spoken = await summarizeTerminalsWithProvider(provider, [
      {
        label: 'Orion',
        engine: 'antigravity',
        state: 'working',
        buffer: 'Crea .kite/tasks/hola.md y node scripts/kite-agent.mjs',
      },
    ]);
    expect(spoken).toMatch(/hola.md/);
  });

  it('builds a local spoken summary without a cloud provider', async () => {
    const provider: PlannerProvider = {
      id: 'local',
      plan: async () => ({ rawText: '{}', latencyMs: 1, model: 'local' }),
    };

    const spoken = await summarizeTerminalsWithProvider(provider, [
      {
        label: 'Orion',
        engine: 'antigravity',
        state: 'waitingForYou',
        buffer: '[Orion] Propuse extraer isBrowserTestLane del shim web.\n',
      },
    ]);
    expect(spoken).toMatch(/En Orion:/);
    expect(spoken).toMatch(/isBrowserTestLane|Propuse/);
  });
});
