import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  createOperatorTurnGate,
  resolveZedOrbState,
  withTurnTimeout,
  withPriorTurnHistory,
  OperatorTurnTimeoutError,
  OPERATOR_TURN_TIMEOUT_MS,
  OPERATOR_TURN_TIMEOUT_MESSAGE,
} from './useOperatorTurnLogic';
import { useOperatorTurn } from './useOperatorTurn';
import { getTurnTraces } from '../trace/trace';
import { runOperatorTurn } from '../index';
import type { OperatorTurnTrace } from '../trace/types';

vi.mock('../trace/trace', () => ({
  getTurnTraces: vi.fn(),
  getTurnTrace: vi.fn(),
  clearTurnTraces: vi.fn(),
  subscribeTrace: vi.fn(() => () => {}),
  getOperatorTraceDiskPath: vi.fn(),
}));

vi.mock('../index', () => ({
  runOperatorTurn: vi.fn(),
}));

function makeTrace(
  turnId: string,
  startedAt: number,
  input: string,
  reply?: string
): OperatorTurnTrace {
  return { turnId, startedAt, input, reply, events: [] };
}

describe('useOperatorTurn logic', () => {
  describe('resolveZedOrbState', () => {
    it('prefers listening over thinking when the mic is active', () => {
      expect(
        resolveZedOrbState({
          turnStage: 'executing',
          voiceError: null,
          turnBusy: true,
          isListening: true,
          speakingTts: false,
        })
      ).toBe('listening');
    });

    it('keeps listening visible when the previous turn is still in error', () => {
      expect(
        resolveZedOrbState({
          turnStage: 'error',
          voiceError: null,
          turnBusy: false,
          isListening: true,
          speakingTts: false,
        })
      ).toBe('listening');
    });

    it('shows thinking when busy and not listening', () => {
      expect(
        resolveZedOrbState({
          turnStage: 'planning',
          voiceError: null,
          turnBusy: true,
          isListening: false,
          speakingTts: false,
        })
      ).toBe('thinking');
    });

    it('shows thinking while cloud transcription runs after mic stops', () => {
      expect(
        resolveZedOrbState({
          turnStage: 'idle',
          voiceError: null,
          turnBusy: false,
          isListening: false,
          isTranscribing: true,
          speakingTts: false,
        })
      ).toBe('thinking');
    });
  });

  describe('withTurnTimeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejects when the operation exceeds the timeout', async () => {
      const pending = withTurnTimeout(
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('late'), OPERATOR_TURN_TIMEOUT_MS + 1000);
        }),
        100
      );

      const expectation = expect(pending).rejects.toBeInstanceOf(OperatorTurnTimeoutError);
      await vi.advanceTimersByTimeAsync(100);
      await expectation;
    });
  });

  describe('withPriorTurnHistory', () => {
    it('builds prior user and assistant turns oldest first from completed traces', () => {
      const traces = [
        makeTrace('turn-2', 200, 'y ahora los tests', 'Los corro.'),
        makeTrace('turn-1', 100, 'abre una terminal', 'Listo.'),
        makeTrace('turn-0', 50, 'estado del repo', 'Sin cambios.'),
      ];

      const result = withPriorTurnHistory('y ahora los tests', undefined, traces);

      expect(result.history).toEqual([
        { role: 'user', content: 'estado del repo' },
        { role: 'assistant', content: 'Sin cambios.' },
        { role: 'user', content: 'abre una terminal' },
        { role: 'assistant', content: 'Listo.' },
        { role: 'user', content: 'y ahora los tests' },
        { role: 'assistant', content: 'Los corro.' },
      ]);
    });

    it('skips the pending trace for the current input when it has no reply', () => {
      const traces = [
        makeTrace('turn-pending', 300, 'corre los tests'),
        makeTrace('turn-1', 100, 'abre una terminal', 'Listo.'),
      ];

      const result = withPriorTurnHistory('corre los tests', undefined, traces);

      expect(result.history).toEqual([
        { role: 'user', content: 'abre una terminal' },
        { role: 'assistant', content: 'Listo.' },
      ]);
    });

    it('keeps caller-provided history unchanged', () => {
      const provided = [{ role: 'user' as const, content: 'contexto previo' }];
      const traces = [makeTrace('turn-1', 100, 'abre una terminal', 'Listo.')];

      const result = withPriorTurnHistory('nueva orden', { history: provided }, traces);

      expect(result.history).toBe(provided);
    });

    it('omits empty turns and assistant messages when the reply is empty', () => {
      const traces = [
        makeTrace('turn-empty', 100, '   '),
        makeTrace('turn-user-only', 200, 'solo usuario'),
      ];

      const result = withPriorTurnHistory('nueva orden', undefined, traces);

      expect(result.history).toEqual([{ role: 'user', content: 'solo usuario' }]);
    });

    it('returns no history when there are no prior turns or caller history', () => {
      expect(withPriorTurnHistory('nueva orden', undefined, [])).toEqual({});
      expect(
        withPriorTurnHistory('nueva orden', undefined, [
          makeTrace('turn-pending', 100, 'nueva orden'),
        ])
      ).toEqual({});
    });
  });

  describe('createOperatorTurnGate', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('queues a second order while the first is in flight without throwing busy', async () => {
      let releaseFirst: (value: string) => void = () => {};
      const run = vi.fn(
        (input: string) =>
          new Promise<string>((resolve) => {
            if (input === 'primera') {
              releaseFirst = resolve;
            } else {
              resolve(`ok:${input}`);
            }
          })
      );

      const gate = createOperatorTurnGate({ run });

      const firstPromise = gate.runTurn('primera');
      const secondPromise = gate.runTurn('segunda');

      expect(gate.isBusy()).toBe(true);
      expect(run).toHaveBeenCalledTimes(1);

      releaseFirst('done-primera');
      await vi.runAllTimersAsync();

      await expect(firstPromise).resolves.toEqual({ input: 'primera', value: 'done-primera' });
      await expect(secondPromise).resolves.toEqual({ input: 'segunda', value: 'ok:segunda' });
      expect(run).toHaveBeenCalledTimes(2);
    });

    it('frees the gate after timeout so a queued order can run', async () => {
      const run = vi.fn(
        (input: string) =>
          new Promise<string>((resolve) => {
            if (input === 'lenta') {
              setTimeout(() => resolve('tarde'), OPERATOR_TURN_TIMEOUT_MS + 5000);
            } else {
              resolve(`ok:${input}`);
            }
          })
      );

      const gate = createOperatorTurnGate({ run, timeoutMs: 100 });

      const slowPromise = gate.runTurn('lenta');
      const queuedPromise = gate.runTurn('cola');

      const slowExpectation = expect(slowPromise).rejects.toThrow(OPERATOR_TURN_TIMEOUT_MESSAGE);
      await vi.advanceTimersByTimeAsync(100);
      await slowExpectation;

      await vi.runAllTimersAsync();
      await expect(queuedPromise).resolves.toEqual({ input: 'cola', value: 'ok:cola' });
      expect(run).toHaveBeenCalledTimes(2);
    });
  });
});

describe('useOperatorTurn hook', () => {
  const runOperatorTurnMock = vi.mocked(runOperatorTurn);
  const getTurnTracesMock = vi.mocked(getTurnTraces);

  beforeEach(() => {
    runOperatorTurnMock.mockReset();
    runOperatorTurnMock.mockResolvedValue({
      turnId: 'turn-result',
      plan: { strategy: 'heuristic', actions: [] },
      receipts: [],
      reply: 'ok',
      overallSuccess: true,
      durationMs: 1,
      strategy: 'heuristic',
    });
    getTurnTracesMock.mockReset();
    getTurnTracesMock.mockReturnValue([]);
  });

  it('forwards existing turn options and adds prior-turn history', async () => {
    getTurnTracesMock.mockReturnValue([
      makeTrace('turn-1', 100, 'abre una terminal', 'Listo.'),
    ]);

    const { result } = renderHook(() => useOperatorTurn('ws-1'));

    await act(async () => {
      await result.current.runTurn('nueva orden', { source: 'texto', ttsEnabled: false });
    });

    expect(runOperatorTurnMock).toHaveBeenCalledWith('nueva orden', {
      workspaceId: 'ws-1',
      source: 'texto',
      ttsEnabled: false,
      history: [
        { role: 'user', content: 'abre una terminal' },
        { role: 'assistant', content: 'Listo.' },
      ],
    });
  });
});
