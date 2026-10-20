// Kite Code — Operator Planner Provider Interface

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PlannerProviderResult {
  rawText: string;
  latencyMs: number;
  model: string;
}

export interface PlannerProvider {
  id: string;
  plan(
    messages: ProviderMessage[],
    options?: { timeoutSecs?: number }
  ): Promise<PlannerProviderResult>;
}
