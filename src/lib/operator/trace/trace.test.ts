import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  emitTrace,
  exportTracesJson,
  getTurnTraces,
  getTurnTrace,
  parseTracesFromJsonl,
  clearTurnTraces,
  subscribeTrace,
} from './trace';
import type { TraceEvent } from './types';

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

  it('folds plan and receipts across the full turn lifecycle', () => {
    const turnId = 't-fold-1';

    emitTrace({
      turnId,
      ev: 'turn.start',
      input: 'Abre dos terminales',
      source: 'texto',
    });

    expect(getTurnTrace(turnId)?.receipts).toEqual([]);

    emitTrace({
      turnId,
      ev: 'plan.created',
      strategy: 'heuristic',
      actions: [{ type: 'open_terminals', count: 2 }],
      reply: 'Abriendo dos terminales.',
    });

    expect(getTurnTrace(turnId)?.plan).toEqual({
      strategy: 'heuristic',
      actions: [{ type: 'open_terminals', count: 2 }],
      reply: 'Abriendo dos terminales.',
    });

    emitTrace({
      turnId,
      ev: 'action.start',
      actionIdx: 0,
      type: 'open_terminals',
      args: { count: 2 },
    });

    emitTrace({
      turnId,
      ev: 'action.verify',
      actionIdx: 0,
      ok: true,
      expected: { terminalsOpened: 2 },
      observed: { terminalsOpened: 2 },
    });

    const afterVerify = getTurnTrace(turnId)?.receipts ?? [];
    expect(afterVerify).toHaveLength(1);
    expect(afterVerify[0]).toMatchObject({
      actionIdx: 0,
      type: 'open_terminals',
      ok: true,
      verification: {
        ok: true,
        expected: { terminalsOpened: 2 },
        observed: { terminalsOpened: 2 },
      },
    });

    emitTrace({
      turnId,
      ev: 'action.end',
      actionIdx: 0,
      type: 'open_terminals',
      status: 'success',
      summaryEs: 'Abrí dos terminales.',
      ms: 42,
    });

    emitTrace({
      turnId,
      ev: 'turn.end',
      overallSuccess: true,
      durationMs: 60,
    });

    const turn = getTurnTrace(turnId);
    expect(turn?.receipts).toEqual([
      {
        actionIdx: 0,
        type: 'open_terminals',
        ok: true,
        summaryEs: 'Abrí dos terminales.',
        durationMs: 42,
        verification: {
          ok: true,
          expected: { terminalsOpened: 2 },
          observed: { terminalsOpened: 2 },
        },
      },
    ]);
    expect(turn?.overallSuccess).toBe(true);
    expect(turn?.durationMs).toBe(60);
  });

  it('records failed receipts with their verification error and keeps action order', () => {
    const turnId = 't-fold-2';

    emitTrace({ turnId, ev: 'turn.start', input: 'Abre dos terminales', source: 'texto' });
    emitTrace({
      turnId,
      ev: 'plan.created',
      strategy: 'heuristic',
      fallbackReason: 'missing-api-key',
      answer: 'No puedo planificar sin proveedor.',
      actions: [
        { type: 'open_terminals', count: 1 },
        { type: 'close_terminals', target: '2' },
      ],
    });

    for (const idx of [0, 1]) {
      emitTrace({ turnId, ev: 'action.start', actionIdx: idx, type: idx === 0 ? 'open_terminals' : 'close_terminals' });
    }

    emitTrace({
      turnId,
      ev: 'action.verify',
      actionIdx: 0,
      ok: false,
      expected: { terminalsOpened: 2 },
      observed: { terminalsOpened: 0 },
      error: 'no-registro-en-registry',
    });
    emitTrace({
      turnId,
      ev: 'action.end',
      actionIdx: 0,
      type: 'open_terminals',
      status: 'failed',
      error: 'spawn-failed',
      ms: 12,
      summaryEs: 'No pude abrir las terminales.',
    });

    emitTrace({
      turnId,
      ev: 'action.verify',
      actionIdx: 1,
      ok: true,
      expected: { terminalsClosed: 1 },
      observed: { terminalsClosed: 1 },
    });
    emitTrace({
      turnId,
      ev: 'action.end',
      actionIdx: 1,
      type: 'close_terminals',
      status: 'success',
      ms: 7,
      summaryEs: 'Cerré la terminal 2.',
    });

    const turn = getTurnTrace(turnId);
    expect(turn?.plan?.fallbackReason).toBe('missing-api-key');
    expect(turn?.plan?.answer).toBe('No puedo planificar sin proveedor.');
    expect(turn?.receipts).toHaveLength(2);

    const [failed, succeeded] = turn?.receipts ?? [];
    expect(failed).toMatchObject({
      actionIdx: 0,
      type: 'open_terminals',
      ok: false,
      summaryEs: 'No pude abrir las terminales.',
      error: 'spawn-failed',
      durationMs: 12,
      verification: { ok: false, error: 'no-registro-en-registry' },
    });
    expect(failed.verification?.observed).toEqual({ terminalsOpened: 0 });
    expect(succeeded).toMatchObject({
      actionIdx: 1,
      type: 'close_terminals',
      ok: true,
      durationMs: 7,
      verification: { ok: true },
    });
  });

  it('exports current traces as pretty-printed JSON', () => {
    emitTrace({ turnId: 't-export-1', ev: 'turn.start', input: 'primero', source: 'texto' });
    emitTrace({ turnId: 't-export-2', ev: 'turn.start', input: 'segundo', source: 'voz' });

    const json = exportTracesJson();
    expect(typeof json).toBe('string');
    expect(json).toContain('\n  ');

    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((t: { turnId: string }) => t.turnId)).toEqual(['t-export-2', 't-export-1']);
    expect(parsed[0]).toEqual(getTurnTraces()[0]);
  });

  it('reconstructs turn traces from JSONL disk lines and skips run ledger rows', () => {
    const captured: TraceEvent[] = [];
    const unsubscribe = subscribeTrace((ev) => captured.push(ev));
    const turnId = 't-jsonl-1';

    emitTrace({ turnId, ev: 'turn.start', input: 'Abre una terminal', source: 'texto' });
    emitTrace({
      turnId,
      ev: 'plan.created',
      strategy: 'heuristic',
      actions: [{ type: 'open_terminals', count: 1 }],
      reply: 'Abriendo una terminal.',
    });
    emitTrace({ turnId, ev: 'action.start', actionIdx: 0, type: 'open_terminals' });
    emitTrace({
      turnId,
      ev: 'action.verify',
      actionIdx: 0,
      ok: true,
      expected: { terminalsOpened: 1 },
      observed: { terminalsOpened: 1 },
    });
    emitTrace({
      turnId,
      ev: 'action.end',
      actionIdx: 0,
      type: 'open_terminals',
      status: 'success',
      ms: 9,
      summaryEs: 'Abrí una terminal.',
    });
    emitTrace({ turnId, ev: 'turn.end', overallSuccess: true, durationMs: 20 });
    unsubscribe();

    const runLedgerLine = JSON.stringify({
      runId: 'run-abc',
      seq: 1,
      timestamp: Date.now(),
      type: 'run_start',
      payload: { input: 'Abre una terminal' },
    });
    const jsonl = [
      runLedgerLine,
      ...captured.map((ev) => JSON.stringify(ev)),
      '',
      'not-json-at-all',
      JSON.stringify({ turnId: 't-jsonl-1' }),
    ].join('\n');

    const turns = parseTracesFromJsonl(jsonl);

    expect(turns).toHaveLength(1);
    const [turn] = turns;
    expect(turn.turnId).toBe(turnId);
    expect(turn.input).toBe('Abre una terminal');
    expect(turn.strategy).toBe('heuristic');
    expect(turn.plan).toEqual({
      strategy: 'heuristic',
      actions: [{ type: 'open_terminals', count: 1 }],
      reply: 'Abriendo una terminal.',
    });
    expect(turn.receipts).toEqual([
      {
        actionIdx: 0,
        type: 'open_terminals',
        ok: true,
        summaryEs: 'Abrí una terminal.',
        durationMs: 9,
        verification: {
          ok: true,
          expected: { terminalsOpened: 1 },
          observed: { terminalsOpened: 1 },
        },
      },
    ]);
    expect(turn.overallSuccess).toBe(true);
    expect(turn.durationMs).toBe(20);
    expect(turn.events).toHaveLength(captured.length);
  });

  it('returns newest turns first when parsing JSONL from disk', () => {
    const captured: TraceEvent[] = [];
    const unsubscribe = subscribeTrace((ev) => captured.push(ev));

    emitTrace({ turnId: 't-jsonl-old', ev: 'turn.start', input: 'viejo', source: 'texto' });
    emitTrace({ turnId: 't-jsonl-old', ev: 'turn.end', overallSuccess: true, durationMs: 1 });
    emitTrace({ turnId: 't-jsonl-new', ev: 'turn.start', input: 'nuevo', source: 'texto' });
    emitTrace({ turnId: 't-jsonl-new', ev: 'turn.end', overallSuccess: true, durationMs: 1 });
    unsubscribe();

    const turns = parseTracesFromJsonl(captured.map((ev) => JSON.stringify(ev)).join('\n'));
    expect(turns.map((t) => t.turnId)).toEqual(['t-jsonl-new', 't-jsonl-old']);
  });

  it('returns an empty list for empty or ledger-only JSONL content', () => {
    expect(parseTracesFromJsonl('')).toEqual([]);
    expect(
      parseTracesFromJsonl(
        JSON.stringify({ runId: 'run-1', seq: 1, timestamp: 1, type: 'run_start', payload: {} })
      )
    ).toEqual([]);
  });

  it('keeps the newest turns first and bounds the in-memory ring buffer to 200 turns', () => {
    for (let i = 0; i < 201; i += 1) {
      emitTrace({ turnId: `t-ring-${i}`, ev: 'turn.start', input: `turno ${i}`, source: 'texto' });
    }

    const turns = getTurnTraces();
    expect(turns).toHaveLength(200);
    expect(turns[0].turnId).toBe('t-ring-200');
    expect(turns[turns.length - 1].turnId).toBe('t-ring-1');
  });

  it('persists turns under the v2 storage key', () => {
    emitTrace({ turnId: 't-store-1', ev: 'turn.start', input: 'persisteme', source: 'texto' });

    const raw = localStorage.getItem('kite.operator.trace.v2');
    expect(raw).toBeTruthy();
    const stored = JSON.parse(raw as string);
    expect(stored).toHaveLength(1);
    expect(stored[0].turnId).toBe('t-store-1');
    expect(stored[0].receipts).toEqual([]);
    expect(localStorage.getItem('kite.operator.traces.v1')).toBeNull();
  });
});
