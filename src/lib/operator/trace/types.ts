// Kite Code — Operator Trace Types
// Defines structured JSONL events for turn execution, planning, action verification, and TTS.

export type TraceEventKind =
  | 'turn.start'
  | 'plan.created'
  | 'action.start'
  | 'ui.request'
  | 'ui.ack'
  | 'action.verify'
  | 'action.end'
  | 'reply.composed'
  | 'tts.speak'
  | 'turn.end';

export interface BaseTraceEvent {
  ts: number;
  turnId: string;
  seq: number;
  ev: TraceEventKind;
}

export interface TurnStartTraceEvent extends BaseTraceEvent {
  ev: 'turn.start';
  input: string;
  source?: 'voz' | 'texto' | 'sugerencia' | 'shortcut';
  mode?: string;
  workspaceId?: string;
  workspaceName?: string;
  workspacePath?: string;
}

export interface PlanCreatedTraceEvent extends BaseTraceEvent {
  ev: 'plan.created';
  strategy: 'llm' | 'heuristic' | 'heuristic-fallback';
  provider?: string;
  model?: string;
  latencyMs?: number;
  actions?: unknown[];
  answer?: string;
  reply?: string;
  rawModelOutputTruncated?: string;
  fallbackReason?: string;
}

export interface ActionStartTraceEvent extends BaseTraceEvent {
  ev: 'action.start';
  actionIdx: number;
  type: string;
  args?: Record<string, unknown>;
}

export interface UiRequestTraceEvent extends BaseTraceEvent {
  ev: 'ui.request';
  reqId: string;
  kind: string;
  payload?: Record<string, unknown>;
}

export interface UiAckTraceEvent extends BaseTraceEvent {
  ev: 'ui.ack';
  reqId: string;
  ok: boolean;
  sessionId?: string;
  reason?: string;
  ms?: number;
}

export interface ActionVerifyTraceEvent extends BaseTraceEvent {
  ev: 'action.verify';
  actionIdx: number;
  actionType?: string;
  expected?: Record<string, unknown>;
  observed?: Record<string, unknown>;
  ok: boolean;
  error?: string;
  verifiedCount?: number;
}

export interface ActionEndTraceEvent extends BaseTraceEvent {
  ev: 'action.end';
  actionIdx: number;
  type: string;
  status: 'success' | 'failed';
  summaryEs?: string;
  error?: string;
  ms?: number;
}

export interface ReplyComposedTraceEvent extends BaseTraceEvent {
  ev: 'reply.composed';
  text: string;
  source?: 'receipts' | 'answer' | 'error' | 'sanitized';
}

export interface TtsSpeakTraceEvent extends BaseTraceEvent {
  ev: 'tts.speak';
  text?: string;
  chars?: number;
  rate?: number;
  lang?: string;
}

export interface TurnEndTraceEvent extends BaseTraceEvent {
  ev: 'turn.end';
  overallSuccess: boolean;
  durationMs?: number;
  error?: string;
}

export type TraceEvent =
  | TurnStartTraceEvent
  | PlanCreatedTraceEvent
  | ActionStartTraceEvent
  | UiRequestTraceEvent
  | UiAckTraceEvent
  | ActionVerifyTraceEvent
  | ActionEndTraceEvent
  | ReplyComposedTraceEvent
  | TtsSpeakTraceEvent
  | TurnEndTraceEvent;

export type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
export type TraceEventInput = DistributiveOmit<TraceEvent, 'ts' | 'seq'> & {
  ts?: number;
  seq?: number;
};

export interface OperatorTurnTrace {
  turnId: string;
  startedAt: number;
  input: string;
  source?: 'voz' | 'texto' | 'sugerencia' | 'shortcut';
  mode?: string;
  workspaceId?: string;
  workspaceName?: string;
  workspacePath?: string;
  strategy?: 'llm' | 'heuristic' | 'heuristic-fallback';
  provider?: string;
  model?: string;
  plan?: OperatorPlanTrace;
  receipts?: ActionReceiptTraceEntry[];
  reply?: string;
  overallSuccess?: boolean;
  durationMs?: number;
  error?: string;
  events: TraceEvent[];
}

/** Folding of the `plan.created` event into the turn trace. */
export interface OperatorPlanTrace {
  strategy: string;
  actions: Array<Record<string, unknown>>;
  answer?: string;
  reply?: string;
  fallbackReason?: string;
}

/** Post-condition verification attached to a single executed action. */
export interface ActionReceiptVerification {
  ok: boolean;
  expected?: Record<string, unknown>;
  observed?: Record<string, unknown>;
  error?: string;
}

/** Folding of the `action.verify` / `action.end` events into the turn trace. */
export interface ActionReceiptTraceEntry {
  actionIdx: number;
  type: string;
  ok: boolean;
  summaryEs?: string;
  error?: string;
  durationMs?: number;
  verification?: ActionReceiptVerification;
}
