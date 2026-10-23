import type { ChatItem } from '../../types';
import { invokeCommand } from '../ipc';
import type { SessionFrame } from './projection';
import type {
  SessionApproval,
  SessionApprovalDecision,
  SessionApprovalResolution,
  SessionBinding,
  SessionLifecycle,
  SessionPlan,
  SessionPlanStatus,
  SessionProjection,
  SessionUsage,
} from './types';

/** Where the recovered thread came from. */
export type RecoverySource = 'log' | 'snapshot';

/** The durable thread as the native fold returns it. */
export interface RecoveredThreadRecord {
  id: string;
  title: string;
  provider: string | null;
  status: string;
  items: ChatItem[];
  plan: SessionPlan | null;
  pendingApprovals: SessionApproval[];
  usage: SessionUsage | null;
}

/**
 * The native recovery payload: the folded thread, its ordered events, and
 * whether a provider-issued handle exists.
 *
 * The payload carries a session; it never carries a process. A renderer that
 * only has this value can show the thread twice without side effects.
 */
export interface RecoveredThreadPayload {
  threadId: string;
  thread: RecoveredThreadRecord;
  events: SessionFrame[];
  source: RecoverySource;
  /** True only when the native boundary reported both the flag and a handle. */
  resumeAvailable: boolean;
  resumeHandle: string | null;
  diagnostic: string | null;
}

/** The resume affordance the UI is allowed to offer. */
export interface ResumeAffordance {
  available: boolean;
  handle: string | null;
  message: string;
}

/** Shown instead of a resume action when no provider handle exists. */
export const NEW_SESSION_MESSAGE = 'A new session will start.';

/** The action offered only with a provider-issued handle. */
export const RESUME_ACTION_LABEL = 'Resume session';

const CHAT_ITEM_KINDS: readonly ChatItem['kind'][] = [
  'user',
  'assistant',
  'reasoning',
  'tool',
  'command',
  'error',
  'note',
  'quotaHandoff',
];

const CHAT_ITEM_STATUSES: readonly NonNullable<ChatItem['status']>[] = [
  'inProgress',
  'running',
  'pending',
  'completed',
  'failed',
  'ready',
];

const PLAN_STATUSES: readonly SessionPlanStatus[] = [
  'ready',
  'revising',
  'implementing',
  'completed',
  'interrupted',
  'failed',
];

const APPROVAL_DECISIONS: readonly SessionApprovalDecision[] = [
  'allowOnce',
  'allowForSession',
  'deny',
  'denyAndStop',
];

/** Session states stored by the event log, mapped onto the lifecycle model. */
const SESSION_STATE_LIFECYCLES: Record<string, SessionLifecycle> = {
  prepared: 'attaching',
  starting: 'attaching',
  running: 'running',
  waiting: 'waiting',
  completed: 'completed',
  interrupted: 'interrupted',
  failed: 'failed',
  resumable: 'resumable',
  closed: 'completed',
};

const LIFECYCLE_BY_THREAD_STATUS: Record<string, SessionLifecycle> = {
  running: 'running',
  waiting: 'waiting',
  error: 'failed',
  idle: 'completed',
};

const KNOWN_LOG_KINDS = new Set([
  'snapshot',
  'field',
  'item.upsert',
  'item.remove',
  'approval.opened',
  'approval.resolved',
  'lifecycle',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

function readNumber(source: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function normalizeHandle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const handle = value.trim();
  return handle.length > 0 ? handle : null;
}

function readPlanStatus(value: unknown): SessionPlanStatus {
  if (typeof value !== 'string') return 'ready';
  return (PLAN_STATUSES as readonly string[]).includes(value)
    ? (value as SessionPlanStatus)
    : 'ready';
}

function readApprovalDecision(value: unknown): SessionApprovalDecision | null {
  if (typeof value !== 'string') return null;
  return (APPROVAL_DECISIONS as readonly string[]).includes(value)
    ? (value as SessionApprovalDecision)
    : null;
}

function readChatItemStatus(value: unknown): ChatItem['status'] {
  if (typeof value !== 'string') return null;
  return (CHAT_ITEM_STATUSES as readonly string[]).includes(value)
    ? (value as NonNullable<ChatItem['status']>)
    : null;
}

function parseBinding(value: unknown): SessionBinding | null {
  if (!isRecord(value)) return null;
  const driver = readString(value, 'driver');
  if (!driver) return null;
  return {
    driver,
    provider: readString(value, 'provider'),
    connectionId: readString(value, 'connectionId', 'connection_id'),
    model: readString(value, 'model'),
    effort: readString(value, 'effort'),
    permission: readString(value, 'permission'),
    workMode: readString(value, 'workMode', 'work_mode'),
    workingDirectory: readString(value, 'workingDirectory', 'working_directory'),
  };
}

function parseItem(value: unknown): ChatItem | null {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id');
  if (!id) return null;
  const kind = readString(value, 'kind');
  return {
    id,
    kind:
      kind !== null && (CHAT_ITEM_KINDS as readonly string[]).includes(kind)
        ? (kind as ChatItem['kind'])
        : 'note',
    text: readString(value, 'text') ?? '',
    title: readString(value, 'title'),
    detail: readString(value, 'detail'),
    status: readChatItemStatus(value.status),
    // A recovered thread has no live stream, so no streaming row can tick.
    streaming: false,
    exitCode: readNumber(value, 'exitCode', 'exit_code'),
    createdAtUnixMs: readNumber(value, 'createdAtUnixMs', 'created_at_unix_ms') ?? 0,
    attachments: Array.isArray(value.attachments) ? value.attachments.slice() : [],
    toolName: readString(value, 'toolName', 'tool_name'),
    toolKind: readString(value, 'toolKind', 'tool_kind'),
    command: readString(value, 'command'),
    filePath: readString(value, 'filePath', 'file_path'),
    addedLines: readNumber(value, 'addedLines', 'added_lines'),
    removedLines: readNumber(value, 'removedLines', 'removed_lines'),
    durationSeconds: readNumber(value, 'durationSeconds', 'duration_seconds'),
  };
}

function parsePlan(thread: Record<string, unknown>): SessionPlan | null {
  const plans = Array.isArray(thread.plans) ? thread.plans : [];
  const activeId = readString(thread, 'activePlanId');
  const active =
    activeId === null
      ? undefined
      : plans.find((plan) => isRecord(plan) && readString(plan, 'id') === activeId);
  const chosen = active ?? plans[plans.length - 1];
  if (!isRecord(chosen)) return null;
  const id = readString(chosen, 'id');
  const markdown = readString(chosen, 'markdown');
  if (!id || markdown === null) return null;
  const sourceTurnId = readString(chosen, 'sourceTurnId', 'source_turn_id');
  return {
    id,
    revision: readNumber(chosen, 'revision') ?? 1,
    markdown,
    status: readPlanStatus(chosen.status),
    ...(sourceTurnId === null ? {} : { sourceTurnId }),
  };
}

function parsePendingApprovals(value: unknown): SessionApproval[] {
  if (!isRecord(value)) return [];
  const id = readString(value, 'id');
  if (!id) return [];
  const toolName = readString(value, 'toolName', 'tool_name', 'kind') ?? 'approval';
  return [
    {
      id,
      toolName,
      title: readString(value, 'title') ?? toolName,
      detail: readString(value, 'detail'),
      risk: readString(value, 'risk') ?? 'Not reported',
      impact: readString(value, 'impact') ?? 'Not reported',
    },
  ];
}

function parseUsage(value: unknown): SessionUsage | null {
  if (!isRecord(value)) return null;
  const durationSeconds = readNumber(value, 'durationSeconds', 'duration_seconds');
  return {
    inputTokens: readNumber(value, 'inputTokens', 'input_tokens') ?? 0,
    outputTokens: readNumber(value, 'outputTokens', 'output_tokens') ?? 0,
    costUsd: readNumber(value, 'costUsd', 'cost_usd') ?? 0,
    ...(durationSeconds === null ? {} : { durationSeconds }),
  };
}

function parseThread(value: unknown): RecoveredThreadRecord | null {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id');
  if (!id) return null;
  return {
    id,
    title: readString(value, 'title') ?? 'Chat Thread',
    provider: readString(value, 'provider'),
    status: readString(value, 'status') ?? 'idle',
    items: Array.isArray(value.items)
      ? value.items.map(parseItem).filter((item): item is ChatItem => item !== null)
      : [],
    plan: parsePlan(value),
    pendingApprovals: parsePendingApprovals(value.pendingApproval),
    usage: parseUsage(value.usage),
  };
}

function parseEvents(value: unknown): SessionFrame[] {
  if (!Array.isArray(value)) return [];
  const events: SessionFrame[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const sequence = readNumber(entry, 'sequence');
    const kind = readString(entry, 'kind');
    if (sequence === null || sequence <= 0 || kind === null || kind.trim().length === 0) continue;
    const atUnixMs = readNumber(entry, 'atUnixMs', 'atMs');
    events.push({
      sequence,
      kind,
      payload: entry.payload,
      ...(atUnixMs === null ? {} : { atUnixMs }),
    });
  }
  return events.sort((left, right) => left.sequence - right.sequence);
}

/**
 * Reads one native recovery payload. Invalid input returns `null`, and a
 * resume flag without a stored handle stays false: the renderer never invents
 * a handle from a boolean.
 */
export function parseRecoveredThread(value: unknown): RecoveredThreadPayload | null {
  if (!isRecord(value)) return null;
  const thread = parseThread(value.thread);
  if (!thread) return null;
  const handle = normalizeHandle(value.resumeHandle);
  const resumeAvailable = value.resumeAvailable === true && handle !== null;
  return {
    threadId: readString(value, 'threadId') ?? thread.id,
    thread,
    events: parseEvents(value.events),
    source: value.source === 'log' ? 'log' : 'snapshot',
    resumeAvailable,
    resumeHandle: handle,
    diagnostic: readString(value, 'diagnostic'),
  };
}

function lifecycleFromEvents(events: readonly SessionFrame[]): SessionLifecycle | null {
  let lifecycle: SessionLifecycle | null = null;
  for (const event of events) {
    if (event.kind !== 'lifecycle' || !isRecord(event.payload)) continue;
    const state = readString(event.payload, 'state');
    if (state === null) continue;
    lifecycle = SESSION_STATE_LIFECYCLES[state] ?? lifecycle;
  }
  return lifecycle;
}

function bindingFromEvents(events: readonly SessionFrame[]): SessionBinding | null {
  let binding: SessionBinding | null = null;
  for (const event of events) {
    if (!isRecord(event.payload)) continue;
    const parsed = parseBinding(event.payload.binding);
    if (parsed) binding = parsed;
  }
  return binding;
}

function approvalResolutionsFromEvents(
  events: readonly SessionFrame[]
): SessionApprovalResolution[] {
  const opened = new Set<string>();
  const resolutions: SessionApprovalResolution[] = [];
  for (const event of events) {
    if (event.kind === 'snapshot') {
      opened.clear();
      continue;
    }
    if (event.kind === 'approval.opened') {
      const approval = isRecord(event.payload) ? event.payload.approval : null;
      const id = isRecord(approval) ? readString(approval, 'id') : null;
      if (id) opened.add(id);
      continue;
    }
    if (event.kind !== 'approval.resolved' || !isRecord(event.payload)) continue;
    const requestId = readString(event.payload, 'requestId', 'request_id');
    const decision = readApprovalDecision(event.payload.decision);
    if (!requestId || !decision || !opened.has(requestId)) continue;
    opened.delete(requestId);
    resolutions.push({ requestId, decision, sequence: event.sequence });
  }
  return resolutions;
}

/**
 * Folds the recovered payload into the projection the existing chat already
 * renders. The input is copied and ordered, no clock is read, and the same
 * payload always produces the same projection.
 */
export function recoveryProjection(recovered: RecoveredThreadPayload): SessionProjection {
  const ordered = [...recovered.events].sort((left, right) => left.sequence - right.sequence);
  const lifecycle =
    lifecycleFromEvents(ordered) ??
    LIFECYCLE_BY_THREAD_STATUS[recovered.thread.status] ??
    'completed';
  const lastSequence = ordered.length === 0 ? 0 : ordered[ordered.length - 1].sequence;
  const unknownEventCount = ordered.filter((event) => !KNOWN_LOG_KINDS.has(event.kind)).length;

  return {
    threadId: recovered.threadId,
    lifecycle,
    binding: bindingFromEvents(ordered),
    items: recovered.thread.items.map((item) => ({ ...item })),
    plan: recovered.thread.plan === null ? null : { ...recovered.thread.plan },
    pendingApprovals: recovered.thread.pendingApprovals.map((approval) => ({ ...approval })),
    approvalResolutions: approvalResolutionsFromEvents(ordered),
    usage: recovered.thread.usage === null ? null : { ...recovered.thread.usage },
    lastSequence,
    unknownEventCount,
  };
}

/** Offers resume only from the stored provider handle. */
export function resumeAffordance(recovered: RecoveredThreadPayload): ResumeAffordance {
  const handle = recovered.resumeAvailable ? normalizeHandle(recovered.resumeHandle) : null;
  if (handle === null) {
    return { available: false, handle: null, message: NEW_SESSION_MESSAGE };
  }
  return { available: true, handle, message: RESUME_ACTION_LABEL };
}

/**
 * Reopens a thread through the native recovery command. This is the only
 * renderer path that reads durable events; it never starts a provider.
 */
export async function loadRecoveredThread(threadId: string): Promise<RecoveredThreadPayload> {
  const raw = await invokeCommand<unknown>('recover_chat_thread', { threadId });
  const recovered = parseRecoveredThread(raw);
  if (!recovered) {
    throw new Error('The recovered thread payload is invalid.');
  }
  return recovered;
}
