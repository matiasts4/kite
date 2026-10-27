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
  // A plain terminal request is a shell pane, never an unrequested AI agent (S3).
  engine: EngineSchema.default('powershell'),
  prompts: z.array(z.string()).optional(),
});

export const CloseTerminalsActionSchema = z.object({
  type: z.literal('close_terminals'),
  target: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).default('finished'),
  count: z.number().int().min(1).optional(),
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

// S7 — multi-agent ODD handoff and terminal-to-terminal piping.
export const HandoffToAgentActionSchema = z.object({
  type: z.literal('handoff_to_agent'),
  sourceTarget: z.union([z.string(), z.number()]).default(1),
  targetEngine: EngineSchema.optional(),
  targetSession: z.union([z.string(), z.number()]).optional(),
  spawnNew: z.boolean().default(true),
  artifactKind: z.enum(['odd', 'output']).default('odd'),
  customPrompt: z.string().optional(),
});

// S8 — spatial control of panes (equalize, split, focus, zoom).
export const ManagePaneLayoutActionSchema = z.object({
  type: z.literal('manage_pane_layout'),
  operation: z
    .enum(['equalize', 'split-horizontal', 'split-vertical', 'focus', 'zoom'])
    .default('equalize'),
  target: z.union([z.string(), z.number()]).optional(),
});

// S9 — workspace switching and view-mode navigation only (no sidebar close, no Git quick actions).
export const SwitchWorkspaceActionSchema = z.object({
  type: z.literal('switch_workspace'),
  workspaceQuery: z.string().min(1),
  viewMode: z.enum(['agents', 'code', 'threads']).optional(),
});

export const ActionSchema = z.discriminatedUnion('type', [
  OpenTerminalsActionSchema,
  CloseTerminalsActionSchema,
  InjectPromptActionSchema,
  OpenBrowserActionSchema,
  NarrateSummaryActionSchema,
  SpawnSubagentActionSchema,
  StopSpeakingActionSchema,
  HandoffToAgentActionSchema,
  ManagePaneLayoutActionSchema,
  SwitchWorkspaceActionSchema,
]);

export type OperatorContractAction = z.infer<typeof ActionSchema>;
export type HandoffToAgentAction = z.infer<typeof HandoffToAgentActionSchema>;
export type ManagePaneLayoutAction = z.infer<typeof ManagePaneLayoutActionSchema>;
export type SwitchWorkspaceAction = z.infer<typeof SwitchWorkspaceActionSchema>;
export type PaneLayoutOperation = ManagePaneLayoutAction['operation'];
export type WorkspaceViewMode = NonNullable<SwitchWorkspaceAction['viewMode']>;

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
  workspaceName?: string;
  workspacePath?: string;
  mode?: string;
  activeTerminals?: Array<{
    sessionId: string;
    who?: string;
    engine?: string;
    title?: string;
    state?: string;
    latestLine?: string;
    idx?: number;
    workspaceId?: string;
  }>;
}

export const OPERATOR_NATIVE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'open_terminals',
      description: 'Open one or more terminal agent panes with an engine and optional prompts.',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'integer', minimum: 1, maximum: 8, default: 1 },
          engine: { type: 'string', enum: ['grok', 'claude', 'codex', 'powershell', 'antigravity', 'opencode'], default: 'powershell' },
          prompts: { type: 'array', items: { type: 'string' } },
        },
        required: ['count'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'close_terminals',
      description: 'Close terminal panes matching a target (session ID, agent name, all, finished, idle, active, last, or numeric index).',
      parameters: {
        type: 'object',
        properties: {
          target: { type: ['string', 'number'], default: 'finished' },
          count: { type: 'integer', minimum: 1, description: 'Optional number of matching terminals to close' },
        },
        required: ['target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inject_prompt',
      description: 'Inject a command or prompt into a running terminal pane.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: ['string', 'number'], default: 1 },
          prompt: { type: 'string' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_browser',
      description: 'Open a URL in the browser surface.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'narrate_summary',
      description: 'Summarize and narrate the active or specified terminal buffer aloud.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: ['string', 'number'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spawn_subagent',
      description: 'Spawn a dedicated subagent with a specific CLI and task.',
      parameters: {
        type: 'object',
        properties: {
          cli: { type: 'string', enum: ['grok', 'claude', 'codex', 'antigravity', 'opencode'], default: 'grok' },
          task: { type: 'string' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_speaking',
      description: 'Halt ongoing text-to-speech audio immediately.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'handoff_to_agent',
      description:
        'Hand a source terminal artifact (ODD document or terminal output) to another agent terminal, spawning a new agent when requested.',
      parameters: {
        type: 'object',
        properties: {
          sourceTarget: { type: ['string', 'number'], default: 1 },
          targetEngine: {
            type: 'string',
            enum: ['grok', 'claude', 'codex', 'powershell', 'antigravity', 'opencode'],
          },
          targetSession: { type: ['string', 'number'] },
          spawnNew: { type: 'boolean', default: true },
          artifactKind: { type: 'string', enum: ['odd', 'output'], default: 'odd' },
          customPrompt: { type: 'string' },
        },
        required: ['sourceTarget'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_pane_layout',
      description:
        'Control pane geometry: equalize all panes to the same dimensions, split, focus or zoom a pane.',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['equalize', 'split-horizontal', 'split-vertical', 'focus', 'zoom'],
            default: 'equalize',
          },
          target: { type: ['string', 'number'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'switch_workspace',
      description: 'Switch to another workspace by name and optionally change the view mode.',
      parameters: {
        type: 'object',
        properties: {
          workspaceQuery: { type: 'string' },
          viewMode: { type: 'string', enum: ['agents', 'code', 'threads'] },
        },
        required: ['workspaceQuery'],
      },
    },
  },
];

// The OpenAI-compatible and Anthropic tool payloads are projections of the single
// source of truth above, so provider defaults (open_terminals.engine = 'powershell')
// can never drift apart again.
export const OPERATOR_TOOLS_OPENAI = OPERATOR_NATIVE_TOOLS;

export const OPERATOR_TOOLS_ANTHROPIC = OPERATOR_NATIVE_TOOLS.map((tool) => ({
  name: tool.function.name,
  description: tool.function.description,
  input_schema: tool.function.parameters,
}));
