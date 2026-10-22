import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createOperatorTurnGate,
  resolveZedOrbState,
  withTurnTimeout,
  OperatorTurnTimeoutError,
  OPERATOR_TURN_TIMEOUT_MS,
  OPERATOR_TURN_TIMEOUT_MESSAGE,
} from './useOperatorTurnLogic';

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
