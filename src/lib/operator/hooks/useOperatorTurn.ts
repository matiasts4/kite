// Kite Code — useOperatorTurn Hook
// Coordinates operator turn execution, live stage tracking (Pensando -> Ejecutando -> Verificando -> Listo),
// and trace timeline inspection.

import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from '../../toast';
import {
  runOperatorTurn,
  type OperatorTurnResult,
  type RunOperatorTurnOptions,
} from '../index';
import {
  getTurnTraces,
  getTurnTrace,
  clearTurnTraces,
  subscribeTrace,
  getOperatorTraceDiskPath,
} from '../trace/trace';
import type { OperatorTurnTrace, TraceEvent } from '../trace/types';
import { invokeCommand } from '../../ipc';
import {
  enqueueTurn,
  takeQueuedTurn,
  withTurnTimeout,
  withPriorTurnHistory,
  OperatorTurnTimeoutError,
  OPERATOR_TURN_TIMEOUT_MESSAGE,
  type QueuedTurn,
  type TurnStage,
} from './useOperatorTurnLogic';

export type { TurnStage };

export function getStageLabelEs(stage: TurnStage, errorDetail?: string): string {
  switch (stage) {
    case 'planning':
      return 'Pensando…';
    case 'executing':
      return 'Ejecutando acciones…';
    case 'verifying':
      return 'Verificando…';
    case 'speaking':
      return 'Hablando…';
    case 'done':
      return 'Listo.';
    case 'error':
      return errorDetail ? `Falló: ${errorDetail}` : 'Falló la operación.';
    case 'idle':
    default:
      return '';
  }
}

export interface UseOperatorTurnReturn {
  busy: boolean;
  stage: TurnStage;
  stageLabel: string;
  lastTurn: OperatorTurnResult | null;
  turns: OperatorTurnTrace[];
  runTurn: (input: string, opts?: RunOperatorTurnOptions) => Promise<OperatorTurnResult>;
  copyTurnTrace: (turnId: string) => Promise<boolean>;
  openLogsFolder: () => Promise<void>;
  clearLogs: () => void;
  rerunTurn: (turnId: string) => Promise<OperatorTurnResult | undefined>;
  resetStage: () => void;
}

export function useOperatorTurn(defaultWorkspaceId?: string | null): UseOperatorTurnReturn {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<TurnStage>('idle');
  const [stageLabel, setStageLabel] = useState('');
  const [lastTurn, setLastTurn] = useState<OperatorTurnResult | null>(null);
  const [turns, setTurns] = useState<OperatorTurnTrace[]>(() => getTurnTraces());
  const resetTimerRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const generationRef = useRef(0);
  const pendingRef = useRef<QueuedTurn<RunOperatorTurnOptions> | null>(null);
  const defaultWorkspaceIdRef = useRef(defaultWorkspaceId);
  defaultWorkspaceIdRef.current = defaultWorkspaceId;

  const executeTurnRef = useRef<
    (input: string, opts?: RunOperatorTurnOptions) => Promise<OperatorTurnResult>
  >(async () => {
    throw new Error('executeTurn not initialized');
  });

  // Sync traces whenever a trace event is emitted
  useEffect(() => {
    setTurns(getTurnTraces());
    const unsubscribe = subscribeTrace((ev: TraceEvent) => {
      setTurns(getTurnTraces());

      // Update stage based on live event stream
      if (ev.ev === 'turn.start') {
        if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
        setStage('planning');
        setStageLabel(getStageLabelEs('planning'));
      } else if (ev.ev === 'plan.created') {
        setStage('executing');
        setStageLabel(getStageLabelEs('executing'));
      } else if (ev.ev === 'action.verify') {
        setStage('verifying');
        setStageLabel(getStageLabelEs('verifying'));
      } else if (ev.ev === 'tts.speak') {
        setStage('speaking');
        setStageLabel(getStageLabelEs('speaking'));
      } else if (ev.ev === 'turn.end') {
        if (ev.overallSuccess) {
          setStage('done');
          setStageLabel(getStageLabelEs('done'));
        } else {
          setStage('error');
          setStageLabel(getStageLabelEs('error', ev.error));
          if (ev.error) {
            toast.error('Asistente Zed', ev.error);
          }
        }

        // Return to idle after 4.5 seconds
        if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = window.setTimeout(() => {
          setStage('idle');
          setStageLabel('');
        }, 4500);
      }
    });

    return () => {
      unsubscribe();
      if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
    };
  }, []);

  const executeTurn = useCallback(
    async (input: string, opts?: RunOperatorTurnOptions): Promise<OperatorTurnResult> => {
      const turnGeneration = ++generationRef.current;

      busyRef.current = true;
      setBusy(true);
      setStage('planning');
      setStageLabel(getStageLabelEs('planning'));

      try {
        const historyOptions = withPriorTurnHistory(input, opts, getTurnTraces());
        const result = await withTurnTimeout(
          runOperatorTurn(input, {
            workspaceId: defaultWorkspaceIdRef.current,
            ...opts,
            ...historyOptions,
          })
        );

        if (generationRef.current === turnGeneration) {
          setLastTurn(result);
        }
        return result;
      } catch (err) {
        if (generationRef.current === turnGeneration) {
          if (err instanceof OperatorTurnTimeoutError) {
            generationRef.current += 1;
          }
          const detail =
            err instanceof OperatorTurnTimeoutError
              ? OPERATOR_TURN_TIMEOUT_MESSAGE
              : err instanceof Error
                ? err.message
                : String(err);
          setStage('error');
          setStageLabel(getStageLabelEs('error', detail));
          toast.error('Asistente Zed', detail);
          if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
          resetTimerRef.current = window.setTimeout(() => {
            setStage('idle');
            setStageLabel('');
          }, 4500);
        }
        throw err instanceof Error ? err : new Error(String(err));
      } finally {
        busyRef.current = false;
        setBusy(false);

        const next = takeQueuedTurn(pendingRef);
        if (next) {
          void executeTurnRef.current(next.input, next.opts).then(next.resolve, next.reject);
        }
      }
    },
    []
  );

  executeTurnRef.current = executeTurn;

  const runTurn = useCallback(
    async (input: string, opts?: RunOperatorTurnOptions): Promise<OperatorTurnResult> => {
      const clean = input.trim();
      if (!clean) {
        throw new Error('Entrada vacía');
      }

      if (busyRef.current) {
        return new Promise<OperatorTurnResult>((resolve, reject) => {
          enqueueTurn(pendingRef, {
            input: clean,
            opts,
            resolve: resolve as (value: unknown) => void,
            reject,
          });
        });
      }

      return executeTurn(clean, opts);
    },
    [executeTurn]
  );

  const copyTurnTrace = useCallback(async (turnId: string): Promise<boolean> => {
    const trace = getTurnTrace(turnId);
    if (!trace) return false;
    try {
      const jsonStr = JSON.stringify(trace, null, 2);
      await navigator.clipboard.writeText(jsonStr);
      return true;
    } catch {
      return false;
    }
  }, []);

  const openLogsFolder = useCallback(async (): Promise<void> => {
    try {
      const diskPath = await getOperatorTraceDiskPath();
      if (diskPath) {
        await invokeCommand('show_in_folder', { path: diskPath });
      }
    } catch (e) {
      console.warn('[useOperatorTurn] No se pudo abrir carpeta de logs:', e);
    }
  }, []);

  const clearLogs = useCallback((): void => {
    clearTurnTraces();
    setTurns([]);
  }, []);

  const rerunTurn = useCallback(
    async (turnId: string): Promise<OperatorTurnResult | undefined> => {
      const trace = getTurnTrace(turnId);
      if (!trace || !trace.input) return undefined;
      return runTurn(trace.input);
    },
    [runTurn]
  );

  const resetStage = useCallback((): void => {
    generationRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    if (resetTimerRef.current) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    setStage('idle');
    setStageLabel('');
  }, []);

  return {
    busy,
    stage,
    stageLabel,
    lastTurn,
    turns,
    runTurn,
    copyTurnTrace,
    openLogsFolder,
    clearLogs,
    rerunTurn,
    resetStage,
  };
}
