import type { ChatItem } from '../../types';

/** The lifecycle of the provider session that serves one thread. */
export type SessionLifecycle =
  | 'creating'
  | 'attaching'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'resumable';

/** Every lifecycle value, in the order a session normally walks them. */
export const SESSION_LIFECYCLES: readonly SessionLifecycle[] = [
  'creating',
  'attaching',
  'running',
  'waiting',
  'completed',
  'interrupted',
  'failed',
  'resumable',
];

/** How a driver keeps a session alive between turns. */
export type SessionMode = 'persistent' | 'resumable' | 'oneShot';

/** The approval vocabulary every adapter maps onto its driver. */
export type SessionApprovalDecision = 'allowOnce' | 'allowForSession' | 'deny' | 'denyAndStop';

/** The binding a live session started with. */
export interface SessionBinding {
  driver: string;
  provider?: string | null;
  connectionId?: string | null;
  model?: string | null;
  effort?: string | null;
  permission?: string | null;
  workMode?: string | null;
  workingDirectory?: string | null;
}

/** One approval request, shaped for the existing approval card. */
export interface SessionApproval {
  id: string;
  toolName: string;
  title: string;
  detail: string | null;
  risk: string;
  impact: string;
}

export type SessionPlanStatus =
  | 'ready'
  | 'revising'
  | 'implementing'
  | 'completed'
  | 'interrupted'
  | 'failed';

/** One proposed plan, shaped for the existing plan panel. */
export interface SessionPlan {
  id: string;
  revision: number;
  markdown: string;
  status: SessionPlanStatus;
  sourceTurnId?: string;
}

/** Token and cost metadata reported by the provider wire. */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationSeconds?: number;
}

export type SessionToolStatus =
  | 'inProgress'
  | 'running'
  | 'pending'
  | 'completed'
  | 'failed'
  | 'ready';

interface SessionEventBase {
  /**
   * Monotonic per-thread sequence. A projection orders events by this value and
   * never resorts them after a replay.
   */
  sequence: number;
  /** Producer timestamp. Absent values project to 0 rather than to wall time. */
  atUnixMs?: number;
}

/**
 * One normalized session event. The renderer never parses a provider frame:
 * the native boundary produces these values, and unknown frames arrive as a
 * bounded `notice`.
 */
export type SessionEvent =
  | (SessionEventBase & {
      kind: 'status';
      lifecycle: SessionLifecycle;
      binding?: SessionBinding;
      message?: string | null;
    })
  | (SessionEventBase & {
      kind: 'text';
      itemId: string;
      text: string;
      streaming?: boolean;
      /** True appends a provider delta; false replaces the item text. */
      append?: boolean;
    })
  | (SessionEventBase & {
      kind: 'reasoning';
      itemId: string;
      text: string;
      streaming?: boolean;
      /** True appends a provider delta; false replaces the item text. */
      append?: boolean;
    })
  | (SessionEventBase & {
      kind: 'tool';
      itemId: string;
      toolName: string;
      title?: string | null;
      detail?: string | null;
      status?: SessionToolStatus | null;
      toolKind?: string | null;
      command?: string | null;
      filePath?: string | null;
      addedLines?: number | null;
      removedLines?: number | null;
      durationSeconds?: number | null;
    })
  | (SessionEventBase & { kind: 'plan'; plan: SessionPlan })
  | (SessionEventBase & { kind: 'approvalOpened'; approval: SessionApproval })
  | (SessionEventBase & {
      kind: 'approvalResolved';
      requestId: string;
      decision: SessionApprovalDecision;
    })
  | (SessionEventBase & {
      kind: 'notice';
      text: string;
      code?: string | null;
      provider?: string | null;
      schema?: string | null;
    })
  | (SessionEventBase & { kind: 'error'; text: string; title?: string | null })
  | (SessionEventBase & { kind: 'usage'; usage: SessionUsage });

export interface SessionApprovalResolution {
  requestId: string;
  decision: SessionApprovalDecision;
  sequence: number;
}

/**
 * The durable projection of one thread's session. It is built by folding
 * normalized events; it never holds a process handle.
 */
export interface SessionProjection {
  threadId: string;
  lifecycle: SessionLifecycle;
  binding: SessionBinding | null;
  items: ChatItem[];
  plan: SessionPlan | null;
  pendingApprovals: SessionApproval[];
  approvalResolutions: SessionApprovalResolution[];
  usage: SessionUsage | null;
  lastSequence: number;
  unknownEventCount: number;
}

/** A control the connected driver may or may not declare. */
export type DriverControlId = 'provider' | 'model' | 'effort' | 'permission' | 'workMode';

export interface DriverChoice {
  id: string;
  label: string;
  detail?: string;
  /** Engine mark rendered by the existing select menu, when the driver has one. */
  engine?: string;
}

export interface DriverModelChoice extends DriverChoice {
  /** Display hint only. The declaration itself is authoritative. */
  supportsEffort?: boolean;
}

export interface DriverWorkModeChoice extends DriverChoice {
  /** Value the thread's existing plan switch takes when this mode is selected. */
  plan: boolean;
}

/**
 * What the connected driver declares for this session. The composer renders
 * these rows and nothing else; a control that is absent renders disabled with
 * the declaration's reason.
 */
export interface DriverDeclaration {
  /** Driver integration kind. Display only, never a capability lookup key. */
  driver: string;
  /** The provider selected for this session. Must appear in `providers`. */
  provider: string;
  sessionMode: SessionMode;
  defaultModel?: string | null;
  defaultEffort?: string | null;
  providers: DriverChoice[];
  models: DriverModelChoice[];
  effort?: DriverChoice[] | null;
  permission?: DriverChoice[] | null;
  workMode?: DriverWorkModeChoice[] | null;
  /** Reasons shown on a control this declaration does not list. */
  unlistedReasons?: Partial<Record<DriverControlId, string>>;
}
