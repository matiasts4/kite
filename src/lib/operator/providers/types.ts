// Kite Code — Operator Planner Provider Interface

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PlannerToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown> | string;
}

export interface PlannerTokenCounts {
  prompt?: number;
  completion?: number;
  cache?: number;
}

export interface PlannerProviderOptions {
  timeoutSecs?: number;
  signal?: AbortSignal;
  stream?: boolean;
  onDelta?: (delta: string) => void;
  onFirstToken?: (timestamp: number) => void;
  onToolCall?: (toolCall: PlannerToolCall) => void;
  tools?: unknown[];
  reasoning?: string;
}

export interface PlannerProviderResult {
  rawText: string;
  latencyMs: number;
  model: string;
  firstTokenMs?: number;
  toolCalls?: PlannerToolCall[];
  tokenCounts?: PlannerTokenCounts;
  reasoning?: string;
}

export interface PlannerProvider {
  id: string;
  plan(
    messages: ProviderMessage[],
    options?: PlannerProviderOptions
  ): Promise<PlannerProviderResult>;
}
