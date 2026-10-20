// Kite Code — Operator Contract & Zod Schemas
// Unified schema and types for Turn, Plan, Action, ActionResult, Receipt, and TurnContext.

import { z } from 'zod';

export const EngineSchema = z.enum([
  'grok',
  'claude',
  'codex',
  'powershell',
  'antigravity',
  'opencode',
  'open-code',
]);

export type Engine = z.infer<typeof EngineSchema>;

export const OpenTerminalsActionSchema = z.object({
  type: z.literal('open_terminals'),
  count: z.number().int().min(1).max(8).default(1),
  engine: EngineSchema.default('grok'),
  prompts: z.array(z.string()).optional(),
});

export const CloseTerminalsActionSchema = z.object({
  type: z.literal('close_terminals'),
  target: z.union([z.string(), z.number()]).default('finished'),
});

export const InjectPromptActionSchema = z.object({
  type: z.literal('inject_prompt'),
  target: z.union([z.string(), z.number()]).default(1),
  prompt: z.string(),
});

export const OpenBrowserActionSchema = z.object({
  type: z.literal('open_browser'),
  url: z.string().url().or(z.string().min(3)),
});

export const NarrateSummaryActionSchema = z.object({
  type: z.literal('narrate_summary'),
  target: z.union([z.string(), z.number()]).optional(),
});

export const SpawnSubagentActionSchema = z.object({
  type: z.literal('spawn_subagent'),
  cli: EngineSchema.default('grok'),
  task: z.string().min(1),
});

export const StopSpeakingActionSchema = z.object({
  type: z.literal('stop_speaking'),
});

export const ActionSchema = z.discriminatedUnion('type', [
  OpenTerminalsActionSchema,
  CloseTerminalsActionSchema,
  InjectPromptActionSchema,
  OpenBrowserActionSchema,
  NarrateSummaryActionSchema,
  SpawnSubagentActionSchema,
  StopSpeakingActionSchema,
]);

export type OperatorContractAction = z.infer<typeof ActionSchema>;

export const PlanStrategySchema = z.enum(['llm', 'heuristic', 'heuristic-fallback']);
export type PlanStrategy = z.infer<typeof PlanStrategySchema>;

export const PlanSchema = z.object({
  strategy: PlanStrategySchema,
  fallbackReason: z.string().optional(),
  actions: z.array(ActionSchema),
  answer: z.string().optional(),
  reply: z.string().optional(),
});

export type OperatorPlan = z.infer<typeof PlanSchema>;

export interface ActionVerification {
  expected: Record<string, unknown>;
  observed: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

export interface ActionReceipt {
  actionIdx: number;
  type: OperatorContractAction['type'] | string;
  ok: boolean;
  summaryEs: string;
  data?: unknown;
  verification?: ActionVerification;
  error?: string;
  durationMs?: number;
}

export interface TurnContext {
  workspaceId?: string;
  mode?: string;
  activeTerminals?: Array<{
    sessionId: string;
    who?: string;
    engine?: string;
    title?: string;
    state?: string;
    latestLine?: string;
  }>;
}
