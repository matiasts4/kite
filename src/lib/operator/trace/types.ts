// Kite Code — Operator Trace Types
// Defines structured JSONL events for turn execution, planning, action verification, and TTS.

export type TraceEventKind =
  | 'vad.speech_start'
  | 'vad.eos'
  | 'stt.start'
  | 'stt.end'
  | 'turn.start'
  | 'intent.route'
  | 'llm.first_token'
  | 'plan.created'
  | 'action.start'
  | 'ui.request'
  | 'ui.ack'
  | 'action.verify'
  | 'action.end'
  | 'reply.composed'
  | 'tts.first_sentence'
  | 'tts.first_audio'
  | 'tts.speak'
  | 'turn.end';

export interface BaseTraceEvent {
  ts: number;
  turnId: string;
  seq: number;
  ev: TraceEventKind;
}

export interface VadSpeechStartTraceEvent extends BaseTraceEvent {
  ev: 'vad.speech_start';
  noiseFloorRms?: number;
  bargeIn?: boolean;
}

export interface VadEosTraceEvent extends BaseTraceEvent {
  ev: 'vad.eos';
  silenceWindowMs?: number;
  speechDurationMs?: number;
}

export interface SttStartTraceEvent extends BaseTraceEvent {
  ev: 'stt.start';
  backend?: string;
  audioDurationMs?: number;
}

export interface SttEndTraceEvent extends BaseTraceEvent {
  ev: 'stt.end';
  backend?: string;
  durationMs?: number;
  chars?: number;
  fallback?: boolean;
  sttFinalizedAt?: number;
}

export interface IntentRouteTraceEvent extends BaseTraceEvent {
  ev: 'intent.route';
  route: 'heuristic' | 'llm' | 'clarification' | 'negation';
  tier?: 'L0' | 'L1' | 'L2';
  transport?: 'cascaded' | 'realtime';
  reason?: string;
  rawInput?: string;
  normalizedInput?: string;
  routerDecisionAt?: number;
}

export interface LlmFirstTokenTraceEvent extends BaseTraceEvent {
  ev: 'llm.first_token';
  provider?: string;
  model?: string;
  firstTokenMs?: number;
  firstTokenAt?: number;
}

export interface TtsFirstSentenceTraceEvent extends BaseTraceEvent {
  ev: 'tts.first_sentence';
  chars?: number;
  streamed?: boolean;
  ttsRequestAt?: number;
}

export interface TtsFirstAudioTraceEvent extends BaseTraceEvent {
  ev: 'tts.first_audio';
  engine?: 'elevenlabs_ws' | 'elevenlabs_http' | 'elevenlabs' | 'browser' | string;
  ttfaMs?: number;
  firstAudioAt?: number;
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
  chatReachKind?: string;
  chatReachText?: string;
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
  reply?: string;
  turnResult?: any;
  tier?: 'L0' | 'L1' | 'L2';
  transport?: 'cascaded' | 'realtime';
  ttsEngine?: 'elevenlabs_ws' | 'elevenlabs_http' | 'browser';
  tokenBreakdown?: {
    systemStaticTokens: number;
    contextDynamicTokens: number;
    toolsSchemaTokens: number;
    historyTokens: number;
    promptTokensTotal: number;
    cachedTokens: number;
    completionTokens: number;
    cacheHitRatio: number;
  };
}

export type TraceEvent =
  | VadSpeechStartTraceEvent
  | VadEosTraceEvent
  | SttStartTraceEvent
  | SttEndTraceEvent
  | TurnStartTraceEvent
  | IntentRouteTraceEvent
  | LlmFirstTokenTraceEvent
  | PlanCreatedTraceEvent
  | ActionStartTraceEvent
  | UiRequestTraceEvent
  | UiAckTraceEvent
  | ActionVerifyTraceEvent
  | ActionEndTraceEvent
  | ReplyComposedTraceEvent
  | TtsFirstSentenceTraceEvent
  | TtsFirstAudioTraceEvent
  | TtsSpeakTraceEvent
  | TurnEndTraceEvent;

export interface LatencyPercentileBucket {
  count: number;
  p50: number;
  p95: number;
  p99?: number;
  avg: number;
}

export interface VoiceLatencySummary {
  sttMs: LatencyPercentileBucket;
  turnToFirstTokenMs: LatencyPercentileBucket;
  turnToFirstAudioMs: LatencyPercentileBucket;
  eosToFirstAudioMs: LatencyPercentileBucket;
}

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
