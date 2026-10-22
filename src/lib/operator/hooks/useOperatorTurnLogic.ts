export type TurnStage =
  | 'idle'
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'speaking'
  | 'done'
  | 'error';

export type ZedStripOrbState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'thinking'
  | 'speaking'
  | 'listening'
  | 'error'
  | 'muted';

/** Llama/Cloudflare can take longer than a short UI beat; 15s aborted the call before it returned. */
export const OPERATOR_TURN_TIMEOUT_MS = 45_000;

export const OPERATOR_TURN_TIMEOUT_MESSAGE = 'La orden no terminó a tiempo.';

export class OperatorTurnTimeoutError extends Error {
  constructor() {
    super(OPERATOR_TURN_TIMEOUT_MESSAGE);
    this.name = 'OperatorTurnTimeoutError';
  }
}

export interface QueuedTurn<T> {
  input: string;
  opts: T | undefined;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/** Replaces any existing queue slot with the latest turn (single-slot queue). */
export function enqueueTurn<T>(
  queueRef: { current: QueuedTurn<T> | null },
  entry: QueuedTurn<T>
): void {
  if (queueRef.current) {
    queueRef.current.reject(new Error('Orden reemplazada por una más reciente.'));
  }
  queueRef.current = entry;
}

export function takeQueuedTurn<T>(queueRef: { current: QueuedTurn<T> | null }): QueuedTurn<T> | null {
  const next = queueRef.current;
  queueRef.current = null;
  return next;
}

export function resolveZedOrbState(args: {
  callLastError?: string | null;
  turnStage: TurnStage;
  voiceError: string | null;
  turnBusy: boolean;
  isListening: boolean;
  isTranscribing?: boolean;
  speakingTts: boolean;
  callOrbState?: ZedStripOrbState;
  callMuted?: boolean;
}): ZedStripOrbState {
  if (args.voiceError) {
    return 'error';
  }
  if (args.isListening) {
    return 'listening';
  }
  if (args.callLastError || args.turnStage === 'error') {
    return 'error';
  }
  if (
    args.isTranscribing ||
    args.turnBusy ||
    args.turnStage === 'planning' ||
    args.turnStage === 'executing' ||
    args.turnStage === 'verifying'
  ) {
    return 'thinking';
  }
  if (args.speakingTts) {
    return 'speaking';
  }
  if (args.callOrbState) {
    return args.callOrbState;
  }
  if (args.callMuted) {
    return 'muted';
  }
  return 'connected';
}

export function withTurnTimeout<T>(
  promise: Promise<T>,
  ms: number = OPERATOR_TURN_TIMEOUT_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new OperatorTurnTimeoutError());
    }, ms);

    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export interface OperatorTurnGateResult {
  input: string;
  value: string;
}

export interface OperatorTurnGate {
  runTurn: (input: string) => Promise<OperatorTurnGateResult>;
  isBusy: () => boolean;
}

/** Pure turn gate: single-slot queue, timeout, generation — for tests and hook parity. */
export function createOperatorTurnGate(options: {
  run: (input: string) => Promise<string>;
  timeoutMs?: number;
  onTimeout?: () => void;
}): OperatorTurnGate {
  let busy = false;
  let generation = 0;
  const pendingRef: { current: QueuedTurn<undefined> | null } = { current: null };

  const execute = async (input: string): Promise<OperatorTurnGateResult> => {
    const turnGeneration = ++generation;
    busy = true;

    try {
      const value = await withTurnTimeout(options.run(input), options.timeoutMs);
      if (generation !== turnGeneration) {
        return { input, value };
      }
      return { input, value };
    } catch (err) {
      if (generation === turnGeneration && err instanceof OperatorTurnTimeoutError) {
        generation += 1;
        options.onTimeout?.();
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      busy = false;
      const next = takeQueuedTurn(pendingRef);
      if (next) {
        void execute(next.input).then(
          (result) => (next.resolve as (value: OperatorTurnGateResult) => void)(result),
          (error) => next.reject(error instanceof Error ? error : new Error(String(error)))
        );
      }
    }
  };

  return {
    isBusy: () => busy,
    runTurn: (input: string) => {
      const clean = input.trim();
      if (!clean) {
        return Promise.reject(new Error('Entrada vacía'));
      }
      if (busy) {
        return new Promise<OperatorTurnGateResult>((resolve, reject) => {
          enqueueTurn(pendingRef, {
            input: clean,
            opts: undefined,
            resolve: resolve as (value: unknown) => void,
            reject,
          });
        });
      }
      return execute(clean);
    },
  };
}
