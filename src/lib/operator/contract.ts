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

export const SubagentDelegationModeSchema = z.enum(['explore', 'odd', 'execute']);
export type SubagentDelegationMode = z.infer<typeof SubagentDelegationModeSchema>;

export const SpawnSubagentActionSchema = z.object({
  type: z.literal('spawn_subagent'),
  cli: EngineSchema.optional(),
  provider: EngineSchema.optional(),
  role: z.string().optional(),
  workspace: z.enum(['inherit', 'share', 'branch']).optional(),
  via: z.enum(['thread', 'terminal']).optional(),
  mode: SubagentDelegationModeSchema.optional(),
  oddMode: z.boolean().optional(),
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

export const LaunchThreadActionSchema = z.object({
  type: z.literal('launch_thread'),
  threadId: z.string().optional(),
  provider: EngineSchema.optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  oddMode: z.boolean().optional(),
  focusThread: z.boolean().optional(),
});

export const LaunchAgentActionSchema = z.object({
  type: z.literal('launch_agent'),
  agentQuery: z.string().optional(),
  provider: EngineSchema.optional(),
  body: z.string().min(1),
  oddMode: z.boolean().optional(),
  focusAgent: z.boolean().optional(),
});

// S3 — Fast read-only workspace inspection actions (`<= 450 ms` budget).
export const PeekChangesActionSchema = z.object({
  type: z.literal('peek_changes'),
  workspaceId: z.string().optional(),
  includeDiff: z.boolean().optional(),
  path: z.string().optional(),
});

export const PeekRunsActionSchema = z.object({
  type: z.literal('peek_runs'),
  limit: z.number().int().min(1).max(20).optional(),
  filterStatus: z.enum(['all', 'running', 'completed', 'failed']).optional(),
});

export const PeekAgentsActionSchema = z.object({
  type: z.literal('peek_agents'),
  scope: z.enum(['all', 'subagents', 'terminals', 'threads', 'autonomous']).optional(),
});

export const PeekFilesActionSchema = z.object({
  type: z.literal('peek_files'),
  path: z.string().min(1),
  mode: z.enum(['signatures', 'map', 'lines', 'full']).default('signatures'),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
});

export const PeekSearchActionSchema = z.object({
  type: z.literal('peek_search'),
  query: z.string().min(1),
  path: z.string().optional(),
  kind: z.enum(['text', 'symbol']).default('text'),
  limit: z.number().int().min(1).max(30).optional(),
});

export const ReadFindingActionSchema = z.object({
  type: z.literal('read_finding'),
  hashOrThreadId: z.string().min(1),
  lines: z.string().optional(),
  search: z.string().optional(),
});

export const RecallConversationsActionSchema = z.object({
  type: z.literal('recall_conversations'),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(10).optional(),
});

// S3 / S7 — Consultative multi-turn proposal & multi-step execution plan lifecycle.
export const DraftStepInputSchema = z.object({
  stepId: z.string().optional(),
  title: z.string().min(1),
  action: z.record(z.string(), z.unknown()),
  dependsOn: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});

export type DraftStepInput = z.infer<typeof DraftStepInputSchema>;

export const ProposeTaskActionSchema = z.object({
  type: z.literal('propose_task'),
  targetKind: z.enum(['subagent', 'thread', 'agent', 'terminal']).default('subagent'),
  title: z.string().min(1),
  taskBrief: z.string().min(1),
  role: z.string().optional(),
  provider: EngineSchema.optional(),
  mode: SubagentDelegationModeSchema.optional(),
  oddMode: z.boolean().optional(),
  workspaceMode: z.enum(['inherit', 'share', 'branch']).optional(),
  questionForUser: z.string().optional(),
  contextRefs: z.array(z.string()).optional(),
  steps: z.array(DraftStepInputSchema).max(5).optional(),
});

export const RefineProposalActionSchema = z.object({
  type: z.literal('refine_proposal'),
  proposalId: z.string().optional(),
  targetKind: z.enum(['subagent', 'thread', 'agent', 'terminal']).optional(),
  title: z.string().optional(),
  taskBrief: z.string().optional(),
  role: z.string().optional(),
  provider: EngineSchema.optional(),
  mode: SubagentDelegationModeSchema.optional(),
  oddMode: z.boolean().optional(),
  workspaceMode: z.enum(['inherit', 'share', 'branch']).optional(),
  questionForUser: z.string().optional(),
  contextRefs: z.array(z.string()).optional(),
  stepIndex: z.number().int().min(1).max(10).optional(),
  stepId: z.string().optional(),
  stepEnabled: z.boolean().optional(),
  stepTitle: z.string().optional(),
  stepActionPatch: z.record(z.string(), z.unknown()).optional(),
  steps: z.array(DraftStepInputSchema).max(5).optional(),
});

export const ConfirmProposalActionSchema = z.object({
  type: z.literal('confirm_proposal'),
  proposalId: z.string().optional(),
});

export const CancelProposalActionSchema = z.object({
  type: z.literal('cancel_proposal'),
  proposalId: z.string().optional(),
  reason: z.string().optional(),
});

export const StaySilentActionSchema = z.object({
  type: z.literal('stay_silent'),
  reason: z.string().optional(),
});

// S2 — Native Kite Tasks operator action (`manage_tasks`).
export const TaskStateFilterSchema = z.enum([
  'Backlog',
  'Todo',
  'To Do',
  'In Progress',
  'Review',
  'Done',
]);

export const TaskPriorityInputSchema = z.enum([
  'Urgent',
  'High',
  'Medium',
  'Normal',
  'Low',
  'No priority',
]);

export const ManageTasksActionSchema = z.object({
  type: z.literal('manage_tasks'),
  operation: z.enum(['list', 'create', 'update', 'move_state']),
  stateFilter: TaskStateFilterSchema.optional(),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(20).optional(),
  taskId: z.string().optional(),
  taskIds: z.array(z.string()).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  priority: TaskPriorityInputSchema.optional(),
  state: TaskStateFilterSchema.optional(),
  oddPath: z.string().optional(),
  confirmed: z.boolean().optional(),
});

// S3 — Active subagent steering/cancellation/reading & Swarm coordination.
export const ControlSubagentActionSchema = z.object({
  type: z.literal('control_subagent'),
  operation: z.enum(['send', 'cancel', 'read_finding']),
  target: z.union([z.string(), z.number()]),
  message: z.string().optional(),
  lines: z.string().optional(),
});

export const SwarmMemberDraftSchema = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  provider: EngineSchema.optional(),
  brief: z.string().optional(),
  workspace: z.enum(['inherit', 'share', 'branch']).optional(),
});

export const CoordinateSwarmActionSchema = z.object({
  type: z.literal('coordinate_swarm'),
  operation: z.enum(['title', 'add', 'post', 'status', 'kill']),
  swarmName: z.string().optional(),
  members: z.array(SwarmMemberDraftSchema).optional(),
  targetMember: z.string().optional(),
  message: z.string().optional(),
  channel: z.string().optional(),
});

// S4 — Routines & Autonomous Schedules control (`manage_routines`).
export const ManageRoutinesActionSchema = z.object({
  type: z.literal('manage_routines'),
  operation: z.enum(['list', 'create', 'toggle', 'run_now']),
  routineId: z.string().optional(),
  routineQuery: z.string().optional(),
  name: z.string().optional(),
  agentQuery: z.string().optional(),
  prompt: z.string().optional(),
  intervalSeconds: z.number().min(900).optional(),
  enabled: z.boolean().optional(),
  permissionMode: z.enum(['readOnly', 'auto', 'fullAccess']).optional(),
  confirmed: z.boolean().optional(),
});

// S6 — Explicit Memory & Knowledge control (`manage_memory`).
export const ManageMemoryActionSchema = z.object({
  type: z.literal('manage_memory'),
  operation: z.enum(['remember', 'search', 'forget']),
  text: z.string().optional(),
  query: z.string().optional(),
  scope: z.enum(['workspace', 'global']).optional(),
});

// S5 — Diff inspection, allowlisted verification checks, and UI view navigation.
export const ReadDiffActionSchema = z.object({
  type: z.literal('read_diff'),
  path: z.string().optional(),
  workspaceId: z.string().optional(),
});

export const RunCheckActionSchema = z.object({
  type: z.literal('run_check'),
  preset: z.enum(['tsc', 'vitest', 'cargo_test', 'sanitizer']),
  targetFilter: z.string().optional(),
});

export const NavigateViewActionSchema = z.object({
  type: z.literal('navigate_view'),
  view: z.enum(['threads', 'code', 'agents', 'diffs', 'tasks', 'routines', 'settings']),
  threadId: z.string().optional(),
  filePath: z.string().optional(),
  taskId: z.string().optional(),
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
  LaunchThreadActionSchema,
  LaunchAgentActionSchema,
  PeekChangesActionSchema,
  PeekRunsActionSchema,
  PeekAgentsActionSchema,
  PeekFilesActionSchema,
  PeekSearchActionSchema,
  ReadFindingActionSchema,
  RecallConversationsActionSchema,
  ProposeTaskActionSchema,
  RefineProposalActionSchema,
  ConfirmProposalActionSchema,
  CancelProposalActionSchema,
  StaySilentActionSchema,
  ManageTasksActionSchema,
  ControlSubagentActionSchema,
  CoordinateSwarmActionSchema,
  ManageRoutinesActionSchema,
  ManageMemoryActionSchema,
  ReadDiffActionSchema,
  RunCheckActionSchema,
  NavigateViewActionSchema,
]);

export const OPERATOR_ACTION_SCHEMA = ActionSchema;

export type OperatorContractAction = z.infer<typeof ActionSchema>;
export type OperatorAction = OperatorContractAction;
export type OperatorActionType = OperatorContractAction['type'];
export type LaunchThreadAction = z.infer<typeof LaunchThreadActionSchema>;
export type LaunchAgentAction = z.infer<typeof LaunchAgentActionSchema>;
export type SpawnSubagentAction = z.infer<typeof SpawnSubagentActionSchema>;
export type HandoffToAgentAction = z.infer<typeof HandoffToAgentActionSchema>;
export type ManagePaneLayoutAction = z.infer<typeof ManagePaneLayoutActionSchema>;
export type SwitchWorkspaceAction = z.infer<typeof SwitchWorkspaceActionSchema>;
export type PeekChangesAction = z.infer<typeof PeekChangesActionSchema>;
export type PeekRunsAction = z.infer<typeof PeekRunsActionSchema>;
export type PeekAgentsAction = z.infer<typeof PeekAgentsActionSchema>;
export type PeekFilesAction = z.infer<typeof PeekFilesActionSchema>;
export type PeekSearchAction = z.infer<typeof PeekSearchActionSchema>;
export type ReadFindingAction = z.infer<typeof ReadFindingActionSchema>;
export type RecallConversationsAction = z.infer<typeof RecallConversationsActionSchema>;
export type ProposeTaskAction = z.infer<typeof ProposeTaskActionSchema>;
export type RefineProposalAction = z.infer<typeof RefineProposalActionSchema>;
export type ConfirmProposalAction = z.infer<typeof ConfirmProposalActionSchema>;
export type CancelProposalAction = z.infer<typeof CancelProposalActionSchema>;
export type StaySilentAction = z.infer<typeof StaySilentActionSchema>;
export type ManageTasksAction = z.infer<typeof ManageTasksActionSchema>;
export type ControlSubagentAction = z.infer<typeof ControlSubagentActionSchema>;
export type CoordinateSwarmAction = z.infer<typeof CoordinateSwarmActionSchema>;
export type ManageRoutinesAction = z.infer<typeof ManageRoutinesActionSchema>;
export type ManageMemoryAction = z.infer<typeof ManageMemoryActionSchema>;
export type ReadDiffAction = z.infer<typeof ReadDiffActionSchema>;
export type RunCheckAction = z.infer<typeof RunCheckActionSchema>;
export type NavigateViewAction = z.infer<typeof NavigateViewActionSchema>;
export type PaneLayoutOperation = ManagePaneLayoutAction['operation'];
export type WorkspaceViewMode = NonNullable<SwitchWorkspaceAction['viewMode']>;

export const PlanStrategySchema = z.enum(['llm', 'heuristic', 'heuristic-fallback']);
export type PlanStrategy = z.infer<typeof PlanStrategySchema>;

export const ClarificationSchema = z.object({
  question: z.string().min(1),
  missingSlot: z.enum(['target', 'task', 'surface', 'provider', 'workspace']),
  candidates: z.array(z.string()).max(4).optional(),
  draftAction: z.record(z.string(), z.unknown()).optional(),
});

export type OperatorClarification = z.infer<typeof ClarificationSchema>;

export const PlanSchema = z.object({
  strategy: PlanStrategySchema,
  fallbackReason: z.string().optional(),
  actions: z.array(ActionSchema),
  answer: z.string().optional(),
  reply: z.string().optional(),
  clarification: ClarificationSchema.optional(),
});

export type OperatorPlan = z.infer<typeof PlanSchema>;

export interface WorkspaceThreadSnapshot {
  id: string;
  title: string;
  provider: string;
  status: string;
  updatedAtUnixMs: number;
}

export interface WorkspaceSubagentSnapshot {
  id: string;
  role: string;
  provider: string;
  status: string;
  parentThreadId?: string;
  title?: string;
  latestActivity?: string;
  findingsSummary?: string;
  updatedAtUnixMs: number;
}

export interface WorkspaceAutonomousAgentSnapshot {
  id: string;
  name: string;
  engine: string;
  status: string;
  activeThreadId?: string;
  updatedAtUnixMs?: number;
}

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
  /** Optional concise conversational narration preferred for voice playback over verbose receipts. */
  spokenSummaryEs?: string;
  /** True when the action intentionally suppresses spoken TTS output (e.g. `stay_silent`). */
  silent?: boolean;
  data?: unknown;
  verification?: ActionVerification;
  error?: string;
  durationMs?: number;
}

export interface TurnContext {
  workspaceId?: string;
  workspaceName?: string;
  workspacePath?: string;
  gitBranch?: string;
  mode?: string;
  boundThreadId?: string;
  voiceSessionActive?: boolean;
  draftProposal?: {
    proposalId: string;
    status: string;
    targetKind: string;
    title: string;
    taskBrief: string;
    role?: string;
    provider?: string;
    mode?: string;
    oddMode?: boolean;
    workspaceMode?: string;
    questionForUser?: string;
    steps?: Array<{
      stepId: string;
      title: string;
      enabled: boolean;
      status: string;
    }>;
    revision: number;
  } | null;
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
  activeThreads?: WorkspaceThreadSnapshot[];
  activeSubagents?: WorkspaceSubagentSnapshot[];
  autonomousAgents?: WorkspaceAutonomousAgentSnapshot[];
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
      description: 'Spawn a dedicated child subagent anchored to the active voice thread via dispatch (default) or terminal with mode (explore read-only vs odd vs execute), optional role, and workspace mode.',
      parameters: {
        type: 'object',
        properties: {
          cli: { type: 'string', enum: ['grok', 'claude', 'codex', 'antigravity', 'opencode'] },
          provider: { type: 'string', enum: ['grok', 'claude', 'codex', 'antigravity', 'opencode'] },
          role: { type: 'string' },
          workspace: { type: 'string', enum: ['inherit', 'share', 'branch'] },
          via: { type: 'string', enum: ['thread', 'terminal'], default: 'thread' },
          mode: { type: 'string', enum: ['explore', 'odd', 'execute'], default: 'explore' },
          oddMode: { type: 'boolean' },
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
  {
    type: 'function',
    function: {
      name: 'launch_thread',
      description: 'Create or message a conversation thread with an optional provider, title, and ODD-first brief.',
      parameters: {
        type: 'object',
        properties: {
          threadId: { type: 'string' },
          provider: { type: 'string', enum: ['grok', 'claude', 'codex', 'antigravity', 'opencode'] },
          title: { type: 'string' },
          body: { type: 'string' },
          oddMode: { type: 'boolean' },
          focusThread: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'launch_agent',
      description: 'Delegate a task to a configured Autonomous Agent profile.',
      parameters: {
        type: 'object',
        properties: {
          agentQuery: { type: 'string' },
          provider: { type: 'string', enum: ['grok', 'claude', 'codex', 'antigravity', 'opencode'] },
          body: { type: 'string' },
          oddMode: { type: 'boolean' },
          focusAgent: { type: 'boolean' },
        },
        required: ['body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'peek_changes',
      description: 'Read-only fast inspection (<450ms) of current git branch, modified files, and workspace changes.',
      parameters: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          includeDiff: { type: 'boolean', default: false },
          path: { type: 'string', description: 'Optional file path filter when includeDiff is true.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'peek_runs',
      description: 'Read-only fast inspection (<450ms) of recent operator runs, terminals, and active tasks.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
          filterStatus: { type: 'string', enum: ['all', 'running', 'completed', 'failed'], default: 'all' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'peek_agents',
      description: 'Read-only fast inspection (<450ms) of active subagents, threads, terminals, and autonomous agents.',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['all', 'subagents', 'terminals', 'threads', 'autonomous'], default: 'all' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'peek_files',
      description: 'Read-only fast compact file inspection (<450ms) via kite-ctx in signatures, map, lines, or full mode.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          mode: { type: 'string', enum: ['signatures', 'map', 'lines', 'full'], default: 'signatures' },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'peek_search',
      description: 'Read-only fast workspace code/symbol search (<450ms) returning bounded file:line matches.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          path: { type: 'string' },
          kind: { type: 'string', enum: ['text', 'symbol'], default: 'text' },
          limit: { type: 'integer', minimum: 1, maximum: 30, default: 10 },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_finding',
      description: 'Read full subagent or verification artifact findings by <<ccr:HASH>>, share key, or childThreadId.',
      parameters: {
        type: 'object',
        properties: {
          hashOrThreadId: { type: 'string' },
          lines: { type: 'string', description: 'Optional line range such as 1-40' },
          search: { type: 'string', description: 'Optional filter term inside the artifact' },
        },
        required: ['hashOrThreadId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_conversations',
      description: 'On-demand recall of past workspace chats and decisions.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_task',
      description: 'Propose a consultative task draft to the user and open a hands-free reply window for confirmation or refinement.',
      parameters: {
        type: 'object',
        properties: {
          targetKind: { type: 'string', enum: ['subagent', 'thread', 'agent', 'terminal'], default: 'subagent' },
          title: { type: 'string' },
          taskBrief: { type: 'string' },
          role: { type: 'string' },
          provider: { type: 'string', enum: ['grok', 'claude', 'codex', 'powershell', 'antigravity', 'opencode'] },
          mode: { type: 'string', enum: ['explore', 'odd', 'execute'] },
          oddMode: { type: 'boolean' },
          workspaceMode: { type: 'string', enum: ['inherit', 'share', 'branch'] },
          questionForUser: { type: 'string' },
          contextRefs: { type: 'array', items: { type: 'string' } },
          steps: {
            type: 'array',
            maxItems: 5,
            items: {
              type: 'object',
              properties: {
                stepId: { type: 'string' },
                title: { type: 'string' },
                action: { type: 'object' },
                dependsOn: { type: 'array', items: { type: 'string' } },
                enabled: { type: 'boolean' },
              },
              required: ['title', 'action'],
            },
          },
        },
        required: ['title', 'taskBrief'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'refine_proposal',
      description: 'Update the active consultative task proposal or a specific step in a multi-step plan based on user feedback.',
      parameters: {
        type: 'object',
        properties: {
          proposalId: { type: 'string' },
          targetKind: { type: 'string', enum: ['subagent', 'thread', 'agent', 'terminal'] },
          title: { type: 'string' },
          taskBrief: { type: 'string' },
          role: { type: 'string' },
          provider: { type: 'string', enum: ['grok', 'claude', 'codex', 'powershell', 'antigravity', 'opencode'] },
          mode: { type: 'string', enum: ['explore', 'odd', 'execute'] },
          oddMode: { type: 'boolean' },
          workspaceMode: { type: 'string', enum: ['inherit', 'share', 'branch'] },
          questionForUser: { type: 'string' },
          contextRefs: { type: 'array', items: { type: 'string' } },
          stepIndex: { type: 'integer', minimum: 1, maximum: 10 },
          stepId: { type: 'string' },
          stepEnabled: { type: 'boolean' },
          stepTitle: { type: 'string' },
          stepActionPatch: { type: 'object' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirm_proposal',
      description: 'Confirm and immediately execute the active task proposal.',
      parameters: {
        type: 'object',
        properties: {
          proposalId: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_proposal',
      description: 'Cancel and discard the active task proposal.',
      parameters: {
        type: 'object',
        properties: {
          proposalId: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stay_silent',
      description: 'Stay silent without vocalizing TTS when audio was ambient noise or requires no spoken reply.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_tasks',
      description: 'List, create, update, or move Kite Tasks issues (auto-linking sourceAgent=Argos and sourceThreadId).',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['list', 'create', 'update', 'move_state'] },
          stateFilter: { type: 'string', enum: ['Backlog', 'Todo', 'To Do', 'In Progress', 'Review', 'Done'] },
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
          taskId: { type: 'string' },
          taskIds: { type: 'array', items: { type: 'string' } },
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['Urgent', 'High', 'Medium', 'Normal', 'Low', 'No priority'] },
          state: { type: 'string', enum: ['Backlog', 'Todo', 'To Do', 'In Progress', 'Review', 'Done'] },
          oddPath: { type: 'string' },
          confirmed: { type: 'boolean' },
        },
        required: ['operation'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'control_subagent',
      description: 'Send guidance to an active subagent, cancel a running child, or read its compressed CcrStore findings.',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['send', 'cancel', 'read_finding'] },
          target: { type: ['string', 'number'] },
          message: { type: 'string' },
          lines: { type: 'string' },
        },
        required: ['operation', 'target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'coordinate_swarm',
      description: 'Title a Swarm, add worker members, post board messages, check status, or stop a worker.',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['title', 'add', 'post', 'status', 'kill'] },
          swarmName: { type: 'string' },
          members: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                role: { type: 'string' },
                provider: { type: 'string', enum: ['grok', 'claude', 'codex', 'antigravity', 'opencode'] },
                brief: { type: 'string' },
                workspace: { type: 'string', enum: ['inherit', 'share', 'branch'] },
              },
              required: ['name'],
            },
          },
          targetMember: { type: 'string' },
          message: { type: 'string' },
          channel: { type: 'string' },
        },
        required: ['operation'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_routines',
      description: 'List, toggle, run immediately, or consultatively create autonomous agent routines.',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['list', 'create', 'toggle', 'run_now'] },
          routineId: { type: 'string' },
          routineQuery: { type: 'string' },
          name: { type: 'string' },
          agentQuery: { type: 'string' },
          prompt: { type: 'string' },
          intervalSeconds: { type: 'number', minimum: 900 },
          enabled: { type: 'boolean' },
          permissionMode: { type: 'string', enum: ['readOnly', 'auto', 'fullAccess'] },
          confirmed: { type: 'boolean' },
        },
        required: ['operation'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_memory',
      description: 'Explicitly remember, search, or forget workspace-scoped or global assistant memory notes.',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['remember', 'search', 'forget'] },
          text: { type: 'string' },
          query: { type: 'string' },
          scope: { type: 'string', enum: ['workspace', 'global'] },
        },
        required: ['operation'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_diff',
      description: 'Read and summarize git file diffs in the active workspace compressed via kite-ctx.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          workspaceId: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_check',
      description: 'Run strictly allowlisted non-destructive verification presets (tsc, vitest, cargo_test, sanitizer).',
      parameters: {
        type: 'object',
        properties: {
          preset: { type: 'string', enum: ['tsc', 'vitest', 'cargo_test', 'sanitizer'] },
          targetFilter: { type: 'string' },
        },
        required: ['preset'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate_view',
      description: 'Navigate the Kite Code UI to threads, code, agents, diffs, tasks, routines, or settings.',
      parameters: {
        type: 'object',
        properties: {
          view: { type: 'string', enum: ['threads', 'code', 'agents', 'diffs', 'tasks', 'routines', 'settings'] },
          threadId: { type: 'string' },
          filePath: { type: 'string' },
          taskId: { type: 'string' },
        },
        required: ['view'],
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
