// Kite Code — Operator Trace Store & Emitter
// Writes structured JSONL trace events to disk via Tauri IPC and keeps in-memory & localStorage cache.

import { invokeCommand } from '../../ipc';
import type { TraceEvent, OperatorTurnTrace, TraceEventInput } from './types';

export type { TraceEvent, OperatorTurnTrace, TraceEventInput } from './types';

const TRACE_STORAGE_KEY = 'kite.operator.trace.v2';
const MAX_TURNS = 200;

class TraceEmitter {
  private turnSeqMap = new Map<string, number>();
  private turns = new Map<string, OperatorTurnTrace>();
  private turnOrder: string[] = [];
  private listeners = new Set<(event: TraceEvent) => void>();
  private initialized = false;

  constructor() {
    this.loadFromStorage();
  }

  private loadFromStorage(): void {
    if (this.initialized || typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(TRACE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && item.turnId) {
              this.turns.set(item.turnId, item);
              this.turnOrder.push(item.turnId);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[OperatorTrace] Error cargando trazas locales:', e);
    } finally {
      this.initialized = true;
    }
  }

  private persistToStorage(): void {
    if (typeof window === 'undefined') return;
    try {
      const turnsArray = this.turnOrder.map((id) => this.turns.get(id)).filter(Boolean);
      localStorage.setItem(TRACE_STORAGE_KEY, JSON.stringify(turnsArray.slice(-MAX_TURNS)));
    } catch (e) {
      console.warn('[OperatorTrace] Error guardando trazas locales:', e);
    }
  }

  public emit(eventInput: TraceEventInput): TraceEvent {
    const turnId = eventInput.turnId;
    const currentSeq = (this.turnSeqMap.get(turnId) || 0) + 1;
    this.turnSeqMap.set(turnId, currentSeq);

    const event = {
      ...eventInput,
      ts: eventInput.ts || Date.now(),
      seq: eventInput.seq || currentSeq,
    } as TraceEvent;

    let turn = this.turns.get(turnId);
    if (!turn) {
      turn = {
        turnId,
        startedAt: event.ts,
        input: event.ev === 'turn.start' ? event.input : '',
        source: event.ev === 'turn.start' ? event.source : 'texto',
        events: [],
      };
      this.turns.set(turnId, turn);
      this.turnOrder.unshift(turnId);

      if (this.turnOrder.length > MAX_TURNS) {
        const removed = this.turnOrder.pop();
        if (removed) {
          this.turns.delete(removed);
          this.turnSeqMap.delete(removed);
        }
      }
    }

    turn.events.push(event);

    // Update turn-level aggregate summary based on event kind
    if (event.ev === 'turn.start') {
      turn.input = event.input;
      turn.source = event.source;
      turn.mode = event.mode;
      turn.workspaceId = event.workspaceId;
    } else if (event.ev === 'plan.created') {
      turn.strategy = event.strategy;
      turn.provider = event.provider;
      turn.model = event.model;
    } else if (event.ev === 'reply.composed') {
      turn.reply = event.text;
    } else if (event.ev === 'turn.end') {
      turn.overallSuccess = event.overallSuccess;
      turn.durationMs = event.durationMs;
      turn.error = event.error;
    }

    this.persistToStorage();

    // Async append to disk via Tauri IPC (fails gracefully when running outside Tauri)
    void invokeCommand('operator_trace_append', {
      line: JSON.stringify(event),
    }).catch(() => {
      // Ignore background disk logging errors in web/test mode
    });

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[OperatorTrace] Error en listener de traza:', err);
      }
    }

    return event;
  }

  public getTurns(): OperatorTurnTrace[] {
    return this.turnOrder.map((id) => this.turns.get(id)!).filter(Boolean);
  }

  public getTurn(turnId: string): OperatorTurnTrace | undefined {
    return this.turns.get(turnId);
  }

  public clear(): void {
    this.turns.clear();
    this.turnOrder = [];
    this.turnSeqMap.clear();
    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem(TRACE_STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  }

  public subscribe(listener: (event: TraceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const traceEmitterInstance = new TraceEmitter();

export function emitTrace(
  event: TraceEventInput
): TraceEvent {
  return traceEmitterInstance.emit(event);
}

export function getTurnTraces(): OperatorTurnTrace[] {
  return traceEmitterInstance.getTurns();
}

export function getTurnTrace(turnId: string): OperatorTurnTrace | undefined {
  return traceEmitterInstance.getTurn(turnId);
}

export function clearTurnTraces(): void {
  traceEmitterInstance.clear();
}

export function subscribeTrace(listener: (event: TraceEvent) => void): () => void {
  return traceEmitterInstance.subscribe(listener);
}

export async function getOperatorTraceDiskPath(): Promise<string> {
  try {
    const res = await invokeCommand<string>('operator_trace_path');
    return res || '';
  } catch {
    return '';
  }
}
