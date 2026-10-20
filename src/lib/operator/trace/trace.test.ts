import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  emitTrace,
  getTurnTraces,
  getTurnTrace,
  clearTurnTraces,
  subscribeTrace,
} from './trace';

vi.mock('../../ipc', () => ({
  invokeCommand: vi.fn().mockResolvedValue({}),
}));

describe('Operator Trace System', () => {
  beforeEach(() => {
    localStorage.clear();
    clearTurnTraces();
  });

  it('records turn lifecycle events in sequence', () => {
    const turnId = 't-test-1';

    emitTrace({
      turnId,
      ev: 'turn.start',
      input: 'Abre 2 terminales con Grok',
      source: 'texto',
      mode: 'chat',
    });

    emitTrace({
      turnId,
      ev: 'plan.created',
      strategy: 'heuristic',
      provider: 'local',
      model: 'heuristic-v1',
      latencyMs: 5,
      actions: [{ type: 'open_terminals', count: 2, engine: 'grok' }],
    });

    emitTrace({
      turnId,
      ev: 'reply.composed',
      text: 'Abriendo 2 terminales con grok.',
      source: 'receipts',
    });

    emitTrace({
      turnId,
      ev: 'turn.end',
      overallSuccess: true,
      durationMs: 45,
    });

    const turns = getTurnTraces();
    expect(turns.length).toBe(1);
    expect(turns[0].turnId).toBe(turnId);
    expect(turns[0].input).toBe('Abre 2 terminales con Grok');
    expect(turns[0].strategy).toBe('heuristic');
    expect(turns[0].reply).toBe('Abriendo 2 terminales con grok.');
    expect(turns[0].overallSuccess).toBe(true);

    const turn = getTurnTrace(turnId);
    expect(turn).toBeDefined();
    expect(turn?.events).toHaveLength(4);
    expect(turn?.events[0].seq).toBe(1);
    expect(turn?.events[1].seq).toBe(2);
    expect(turn?.events[2].seq).toBe(3);
    expect(turn?.events[3].seq).toBe(4);
  });

  it('notifies subscribers on each emitted event', () => {
    const events: any[] = [];
    const unsubscribe = subscribeTrace((ev) => events.push(ev));

    emitTrace({
      turnId: 't-sub-1',
      ev: 'turn.start',
      input: 'silencio',
      source: 'voz',
    });

    expect(events.length).toBe(1);
    expect(events[0].ev).toBe('turn.start');
    expect(events[0].input).toBe('silencio');

    unsubscribe();
    emitTrace({
      turnId: 't-sub-1',
      ev: 'turn.end',
      overallSuccess: true,
      durationMs: 10,
    });
    expect(events.length).toBe(1);
  });
});
