// Kite Code — Operator Trace Store & Emitter
// Writes structured JSONL trace events to disk via Tauri IPC and keeps in-memory & localStorage cache.

import { invokeCommand } from '../../ipc';
import type {
  TraceEvent,
  TraceEventKind,
  OperatorTurnTrace,
  TraceEventInput,
  ActionReceiptTraceEntry,
  LatencyPercentileBucket,
  VoiceLatencySummary,
} from './types';

export type {
  TraceEvent,
  OperatorTurnTrace,
  TraceEventInput,
  OperatorPlanTrace,
  ActionReceiptTraceEntry,
  ActionReceiptVerification,
  LatencyPercentileBucket,
  VoiceLatencySummary,
} from './types';

const TRACE_STORAGE_KEY = 'kite.operator.trace.v2';
const MAX_TURNS = 200;

// Exhaustive map: adding a new `TraceEventKind` forces this table to be updated,
// so the JSONL parser never silently drops a valid event kind.
const TRACE_EVENT_KIND_MAP: Record<TraceEventKind, true> = {
  'vad.speech_start': true,
  'vad.eos': true,
  'stt.start': true,
  'stt.end': true,
  'turn.start': true,
  'intent.route': true,
  'llm.first_token': true,
  'plan.created': true,
  'action.start': true,
  'ui.request': true,
  'ui.ack': true,
  'action.verify': true,
  'action.end': true,
  'reply.composed': true,
  'tts.first_sentence': true,
  'tts.first_audio': true,
  'tts.speak': true,
  'turn.end': true,
};

const TRACE_EVENT_KINDS: ReadonlySet<string> = new Set<string>(Object.keys(TRACE_EVENT_KIND_MAP));

/** Finds the action type announced by the `action.start` event for a given index. */
function findActionType(turn: OperatorTurnTrace, actionIdx: number): string {
  for (let i = turn.events.length - 1; i >= 0; i -= 1) {
    const ev = turn.events[i];
    if (ev.ev === 'action.start' && ev.actionIdx === actionIdx) {
      return ev.type;
    }
  }
  return '';
}

/** Returns the receipt entry for an action index, creating it when missing. */
function resolveReceiptEntry(
  turn: OperatorTurnTrace,
  actionIdx: number
): ActionReceiptTraceEntry {
  if (!turn.receipts) {
    turn.receipts = [];
  }
  const existing = turn.receipts.find((receipt) => receipt.actionIdx === actionIdx);
  if (existing) {
    return existing;
  }
  const created: ActionReceiptTraceEntry = {
    actionIdx,
    type: findActionType(turn, actionIdx),
    ok: false,
  };
  turn.receipts.push(created);
  turn.receipts.sort((a, b) => a.actionIdx - b.actionIdx);
  return created;
}

/**
 * Folds a single trace event into the aggregated turn summary.
 * Shared by the live emitter and the JSONL disk reconstruction path so both
 * produce exactly the same `OperatorTurnTrace` shape.
 */
function applyTraceEventToTurn(turn: OperatorTurnTrace, event: TraceEvent): void {
  turn.events.push(event);

  switch (event.ev) {
    case 'turn.start':
      turn.input = event.input;
      turn.source = event.source;
      turn.mode = event.mode;
      turn.workspaceId = event.workspaceId;
      turn.workspaceName = event.workspaceName;
      turn.workspacePath = event.workspacePath;
      break;

    case 'plan.created':
      turn.strategy = event.strategy;
      turn.provider = event.provider;
      turn.model = event.model;
      turn.plan = {
        strategy: event.strategy,
        actions: (event.actions ?? []) as Array<Record<string, unknown>>,
        answer: event.answer,
        reply: event.reply,
        fallbackReason: event.fallbackReason,
      };
      break;

    case 'action.verify': {
      const receipt = resolveReceiptEntry(turn, event.actionIdx);
      receipt.ok = event.ok;
      if (!receipt.type && event.actionType) {
        receipt.type = event.actionType;
      }
      receipt.verification = {
        ok: event.ok,
        expected: event.expected,
        observed: event.observed,
        error: event.error,
      };
      break;
    }

    case 'action.end': {
      const receipt = resolveReceiptEntry(turn, event.actionIdx);
      receipt.type = event.type || receipt.type;
      receipt.ok = event.status === 'success';
      receipt.summaryEs = event.summaryEs;
      receipt.error = event.error;
      receipt.durationMs = event.ms;
      break;
    }

    case 'reply.composed':
      turn.reply = event.text;
      break;

    case 'turn.end':
      turn.overallSuccess = event.overallSuccess;
      turn.durationMs = event.durationMs;
      turn.error = event.error;
      break;

    default:
      break;
  }
}

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
        receipts: [],
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

    // Folds the event into the turn aggregate (plan, receipts, reply, outcome).
    applyTraceEventToTurn(turn, event);

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

/** Serializes the in-memory ring buffer as pretty-printed JSON. */
export function exportTracesJson(): string {
  return JSON.stringify(getTurnTraces(), null, 2);
}

/**
 * Rebuilds `OperatorTurnTrace[]` from the `.jsonl` lines appended by the
 * `operator_trace_append` Tauri command.
 *
 * Lines that are not turn trace events (for example `runLedger` rows, which
 * carry `runId` instead of `turnId` / `ev`), blank lines, and malformed JSON
 * are skipped. The result is ordered newest turn first, matching
 * `getTurnTraces()`. This lets Node CLI scripts inspect real disk traces
 * without a `window` / `localStorage` runtime.
 */
export function parseTracesFromJsonl(jsonlContent: string): OperatorTurnTrace[] {
  const turns = new Map<string, OperatorTurnTrace>();
  const firstSeenIndex = new Map<string, number>();
  let lineIndex = 0;

  for (const rawLine of jsonlContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

    const record = parsed as Record<string, unknown>;
    const turnId = typeof record.turnId === 'string' ? record.turnId : '';
    const kind = typeof record.ev === 'string' ? record.ev : '';
    if (!turnId || !TRACE_EVENT_KINDS.has(kind)) continue;

    const event = {
      ...record,
      ts: typeof record.ts === 'number' ? record.ts : 0,
      seq: typeof record.seq === 'number' ? record.seq : 0,
    } as unknown as TraceEvent;

    let turn = turns.get(turnId);
    if (!turn) {
      turn = {
        turnId,
        startedAt: event.ts,
        input: '',
        receipts: [],
        events: [],
      };
      turns.set(turnId, turn);
      firstSeenIndex.set(turnId, lineIndex);
    }
    lineIndex += 1;

    applyTraceEventToTurn(turn, event);
  }

  return Array.from(turns.values()).sort((a, b) => {
    if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt;
    return (firstSeenIndex.get(b.turnId) ?? 0) - (firstSeenIndex.get(a.turnId) ?? 0);
  });
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

export async function revealOperatorTraceDiskFolder(): Promise<void> {
  try {
    await invokeCommand('operator_trace_reveal');
  } catch (err) {
    console.warn('[Trace] No se pudo abrir la carpeta de trazas:', err);
  }
}

function summarizeLatencies(samples: number[]): LatencyPercentileBucket {
  if (samples.length === 0) {
    return { count: 0, p50: 0, p95: 0, avg: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (p: number) => {
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    const w = idx - lo;
    return Math.round(sorted[lo] * (1 - w) + sorted[hi] * w);
  };
  const avg = Math.round(sorted.reduce((sum, n) => sum + n, 0) / sorted.length);
  return {
    count: sorted.length,
    p50: pick(50),
    p95: pick(95),
    avg,
  };
}

/**
 * Aggregates end-to-end voice latency milestones across turns (STT, TTFT, TTFA, EoS -> First Audio).
 */
export function computeVoiceLatencySummary(
  traces: OperatorTurnTrace[] = getTurnTraces()
): VoiceLatencySummary {
  const sttSamples: number[] = [];
  const ttftSamples: number[] = [];
  const ttfaSamples: number[] = [];
  const eosToAudioSamples: number[] = [];

  for (const turn of traces) {
    let eosTs: number | undefined;
    let sttStartTs: number | undefined;
    let sttEndTs: number | undefined;
    let sttDurationMs: number | undefined;
    let turnStartTs: number | undefined;
    let firstTokenTs: number | undefined;
    let firstAudioTs: number | undefined;

    for (const ev of turn.events) {
      switch (ev.ev) {
        case 'vad.eos':
          if (eosTs === undefined) eosTs = ev.ts;
          break;
        case 'stt.start':
          if (sttStartTs === undefined) sttStartTs = ev.ts;
          break;
        case 'stt.end':
          sttEndTs = ev.ts;
          if (typeof ev.durationMs === 'number' && ev.durationMs >= 0) {
            sttDurationMs = ev.durationMs;
          }
          break;
        case 'turn.start':
          if (turnStartTs === undefined) turnStartTs = ev.ts;
          break;
        case 'llm.first_token':
          if (firstTokenTs === undefined) firstTokenTs = ev.ts;
          break;
        case 'tts.first_audio':
          if (firstAudioTs === undefined) firstAudioTs = ev.ts;
          break;
        default:
          break;
      }
    }

    if (sttDurationMs !== undefined) {
      sttSamples.push(sttDurationMs);
    } else if (sttStartTs !== undefined && sttEndTs !== undefined && sttEndTs >= sttStartTs) {
      sttSamples.push(sttEndTs - sttStartTs);
    }

    if (turnStartTs !== undefined && firstTokenTs !== undefined && firstTokenTs >= turnStartTs) {
      ttftSamples.push(firstTokenTs - turnStartTs);
    }

    if (turnStartTs !== undefined && firstAudioTs !== undefined && firstAudioTs >= turnStartTs) {
      ttfaSamples.push(firstAudioTs - turnStartTs);
    }

    if (eosTs !== undefined && firstAudioTs !== undefined && firstAudioTs >= eosTs) {
      eosToAudioSamples.push(firstAudioTs - eosTs);
    }
  }

  return {
    sttMs: summarizeLatencies(sttSamples),
    turnToFirstTokenMs: summarizeLatencies(ttftSamples),
    turnToFirstAudioMs: summarizeLatencies(ttfaSamples),
    eosToFirstAudioMs: summarizeLatencies(eosToAudioSamples),
  };
}
