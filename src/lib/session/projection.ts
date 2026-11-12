import type { ChatItem } from '../../types';
import {
  SESSION_LIFECYCLES,
  type SessionApproval,
  type SessionApprovalDecision,
  type SessionApprovalResolution,
  type SessionBinding,
  type SessionEvent,
  type SessionLifecycle,
  type SessionPlan,
  type SessionPlanStatus,
  type SessionProjection,
  type SessionToolStatus,
  type SessionUsage,
} from './types';

/** A raw event handed to the normalizer by the native session boundary. */
export interface SessionFrame {
  sequence: number;
  kind: string;
  payload?: unknown;
  atUnixMs?: number;
}

export interface SessionFrameContext {
  provider?: string | null;
  schema?: string | null;
}

const NOTICE_TEXT_LIMIT = 512;
const PREVIEW_LIMIT = 160;
const KIND_LIMIT = 80;

const PLAN_STATUSES: readonly SessionPlanStatus[] = [
  'ready',
  'revising',
  'implementing',
  'completed',
  'interrupted',
  'failed',
];

const TOOL_STATUSES: readonly SessionToolStatus[] = [
  'inProgress',
  'running',
  'pending',
  'completed',
  'failed',
  'ready',
];

const APPROVAL_DECISIONS: readonly SessionApprovalDecision[] = [
  'allowOnce',
  'allowForSession',
  'deny',
  'denyAndStop',
];

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

function readBoolean(source: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') return value;
  }
  return null;
}

function boundedText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function previewPayload(value: unknown): string {
  if (value === undefined) return 'no payload';
  if (typeof value === 'string') return value;
  try {
    const encoded = JSON.stringify(value);
    return encoded ?? String(value);
  } catch {
    return '[unserializable payload]';
  }
}

function readLifecycle(value: unknown): SessionLifecycle | null {
  if (typeof value !== 'string') return null;
  return (SESSION_LIFECYCLES as readonly string[]).includes(value)
    ? (value as SessionLifecycle)
    : null;
}

function readPlanStatus(value: unknown): SessionPlanStatus {
  if (typeof value !== 'string') return 'ready';
  return (PLAN_STATUSES as readonly string[]).includes(value)
    ? (value as SessionPlanStatus)
    : 'ready';
}

function readToolStatus(value: unknown): SessionToolStatus | null {
  if (typeof value !== 'string') return null;
  return (TOOL_STATUSES as readonly string[]).includes(value)
    ? (value as SessionToolStatus)
    : null;
}

function readDecision(value: unknown): SessionApprovalDecision | null {
  if (typeof value !== 'string') return null;
  return (APPROVAL_DECISIONS as readonly string[]).includes(value)
    ? (value as SessionApprovalDecision)
    : null;
}

function readBinding(value: unknown): SessionBinding | undefined {
  if (!isRecord(value)) return undefined;
  const driver = readString(value, 'driver');
  if (!driver) return undefined;
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

function noticeEvent(
  frame: SessionFrame,
  context: SessionFrameContext,
  code: 'unknownFrame' | 'invalidFrame'
): SessionEvent {
  const provider = context.provider?.trim() || 'provider';
  const schema = context.schema?.trim() || 'unknown schema';
  const prefix = code === 'unknownFrame' ? 'Unrecognized' : 'Malformed';
  const kind = boundedText(frame.kind, KIND_LIMIT);
  const preview = boundedText(previewPayload(frame.payload), PREVIEW_LIMIT);
  const text = `${prefix} ${provider} frame "${kind}" (schema ${schema}): ${preview}`;
  return {
    sequence: frame.sequence,
    ...(frame.atUnixMs === undefined ? {} : { atUnixMs: frame.atUnixMs }),
    kind: 'notice',
    text: boundedText(text, NOTICE_TEXT_LIMIT),
    code,
    provider,
    schema,
  };
}

/**
 * Turns one raw boundary frame into a normalized event. A frame this build does
 * not recognize becomes a bounded notice carrying provider and schema metadata;
 * it never reaches the renderer as a raw provider object.
 */
export function normalizeSessionFrame(
  frame: SessionFrame,
  context: SessionFrameContext = {}
): SessionEvent {
  const payload = isRecord(frame.payload) ? frame.payload : {};
  const base = {
    sequence: frame.sequence,
    ...(frame.atUnixMs === undefined ? {} : { atUnixMs: frame.atUnixMs }),
  };

  switch (frame.kind) {
    case 'status': {
      const lifecycle = readLifecycle(payload.lifecycle) ?? readLifecycle(payload.state);
      if (!lifecycle) return noticeEvent(frame, context, 'invalidFrame');
      const binding = readBinding(payload.binding);
      const message = readString(payload, 'message', 'reason');
      return {
        ...base,
        kind: 'status',
        lifecycle,
        ...(binding ? { binding } : {}),
        ...(message === null ? {} : { message }),
      };
    }
    case 'creating':
    case 'attaching':
    case 'running':
    case 'waiting':
    case 'completed':
    case 'interrupted':
    case 'failed':
    case 'resumable':
      return {
        ...base,
        kind: 'status',
        lifecycle: frame.kind as SessionLifecycle,
        message: readString(payload, 'message', 'reason'),
      };
    case 'started':
    case 'resumed': {
      const binding = readBinding(payload.binding);
      return {
        ...base,
        kind: 'status',
        lifecycle: 'running',
        ...(binding ? { binding } : {}),
      };
    }
    case 'stopped':
      return { ...base, kind: 'status', lifecycle: 'interrupted' };
    case 'exited': {
      const state = readLifecycle(payload.state);
      const error = readString(payload, 'error');
      if (error) return { ...base, kind: 'status', lifecycle: 'failed', message: error };
      if (state) return { ...base, kind: 'status', lifecycle: state };
      const code = readNumber(payload, 'code');
      if (code !== null && code !== 0) {
        return {
          ...base,
          kind: 'status',
          lifecycle: 'failed',
          message: `The provider process exited with code ${code}.`,
        };
      }
      return { ...base, kind: 'status', lifecycle: 'completed' };
    }
    case 'text': {
      const text = readString(payload, 'text');
      if (text === null) return noticeEvent(frame, context, 'invalidFrame');
      return {
        ...base,
        kind: 'text',
        itemId: readString(payload, 'itemId', 'item_id') ?? 'assistant',
        text,
        streaming: readBoolean(payload, 'streaming') ?? true,
        append: readBoolean(payload, 'append') ?? true,
      };
    }
    case 'reasoning': {
      const text = readString(payload, 'text');
      if (text === null) return noticeEvent(frame, context, 'invalidFrame');
      return {
        ...base,
        kind: 'reasoning',
        itemId: readString(payload, 'itemId', 'item_id') ?? 'reasoning',
        text,
        streaming: readBoolean(payload, 'streaming') ?? true,
        append: readBoolean(payload, 'append') ?? true,
      };
    }
    case 'tool': {
      const toolName = readString(payload, 'toolName', 'name');
      if (toolName === null) return noticeEvent(frame, context, 'invalidFrame');
      return {
        ...base,
        kind: 'tool',
        itemId: readString(payload, 'itemId', 'item_id') ?? `tool-${frame.sequence}`,
        toolName,
        title: readString(payload, 'title'),
        detail: readString(payload, 'detail'),
        status: readToolStatus(payload.status),
        toolKind: readString(payload, 'toolKind', 'tool_kind'),
        command: readString(payload, 'command'),
        filePath: readString(payload, 'filePath', 'file_path'),
        addedLines: readNumber(payload, 'addedLines', 'added_lines'),
        removedLines: readNumber(payload, 'removedLines', 'removed_lines'),
        durationSeconds: readNumber(payload, 'durationSeconds', 'duration_seconds'),
      };
    }
    case 'plan': {
      const source = isRecord(payload.plan) ? payload.plan : payload;
      const markdown = readString(source, 'markdown');
      if (markdown === null) return noticeEvent(frame, context, 'invalidFrame');
      const sourceTurnId = readString(source, 'sourceTurnId', 'source_turn_id');
      return {
        ...base,
        kind: 'plan',
        plan: {
          id: readString(source, 'id') ?? `plan-${frame.sequence}`,
          revision: readNumber(source, 'revision') ?? 1,
          markdown,
          status: readPlanStatus(source.status),
          ...(sourceTurnId === null ? {} : { sourceTurnId }),
        },
      };
    }
    case 'approvalOpened': {
      const requestId = readString(payload, 'requestId', 'request_id', 'id');
      if (requestId === null) return noticeEvent(frame, context, 'invalidFrame');
      const toolName = readString(payload, 'kind', 'toolName', 'tool_name') ?? 'approval';
      return {
        ...base,
        kind: 'approvalOpened',
        approval: {
          id: requestId,
          toolName,
          title: readString(payload, 'title') ?? toolName,
          detail: readString(payload, 'detail'),
          risk: readString(payload, 'risk') ?? 'Not reported',
          impact: readString(payload, 'impact') ?? 'Not reported',
        },
      };
    }
    case 'approvalResolved': {
      const requestId = readString(payload, 'requestId', 'request_id', 'id');
      const decision = readDecision(readString(payload, 'decision'));
      if (requestId === null || decision === null) return noticeEvent(frame, context, 'invalidFrame');
      return { ...base, kind: 'approvalResolved', requestId, decision };
    }
    case 'approvalSettled': {
      const requestId = readString(payload, 'requestId', 'request_id', 'id');
      const decision = readDecision(readString(payload, 'decision')) ?? 'deny';
      if (requestId === null) return noticeEvent(frame, context, 'invalidFrame');
      return { ...base, kind: 'approvalResolved', requestId, decision };
    }
    case 'notice': {
      const text = readString(payload, 'text', 'message');
      if (text === null) return noticeEvent(frame, context, 'invalidFrame');
      return {
        ...base,
        kind: 'notice',
        text: boundedText(text, NOTICE_TEXT_LIMIT),
        code: readString(payload, 'code'),
        provider: readString(payload, 'provider') ?? context.provider ?? null,
        schema: readString(payload, 'schema') ?? context.schema ?? null,
      };
    }
    case 'error': {
      const text = readString(payload, 'text', 'message', 'reason');
      if (text === null) return noticeEvent(frame, context, 'invalidFrame');
      return { ...base, kind: 'error', text, title: readString(payload, 'title') };
    }
    case 'usage': {
      const durationSeconds = readNumber(payload, 'durationSeconds', 'duration_seconds');
      return {
        ...base,
        kind: 'usage',
        usage: {
          inputTokens: readNumber(payload, 'inputTokens', 'input_tokens') ?? 0,
          outputTokens: readNumber(payload, 'outputTokens', 'output_tokens') ?? 0,
          costUsd: readNumber(payload, 'costUsd', 'cost_usd') ?? 0,
          ...(durationSeconds === null ? {} : { durationSeconds }),
        },
      };
    }
    default:
      return noticeEvent(frame, context, 'unknownFrame');
  }
}

/** Normalizes a whole batch of boundary frames in sequence order. */
export function normalizeSessionFrames(
  frames: readonly SessionFrame[],
  context: SessionFrameContext = {}
): SessionEvent[] {
  return frames.map((frame) => normalizeSessionFrame(frame, context));
}

interface ChatItemFields {
  id: string;
  text: string;
  title?: string | null;
  detail?: string | null;
  status?: ChatItem['status'];
  streaming?: boolean;
  toolName?: string | null;
  toolKind?: string | null;
  command?: string | null;
  filePath?: string | null;
  addedLines?: number | null;
  removedLines?: number | null;
  durationSeconds?: number | null;
}

function chatItem(event: SessionEvent, kind: ChatItem['kind'], fields: ChatItemFields): ChatItem {
  return {
    id: fields.id,
    kind,
    text: fields.text,
    title: fields.title ?? null,
    detail: fields.detail ?? null,
    status: fields.status ?? null,
    streaming: fields.streaming ?? false,
    exitCode: null,
    createdAtUnixMs: event.atUnixMs ?? 0,
    attachments: [],
    toolName: fields.toolName ?? null,
    toolKind: fields.toolKind ?? null,
    command: fields.command ?? null,
    filePath: fields.filePath ?? null,
    addedLines: fields.addedLines ?? null,
    removedLines: fields.removedLines ?? null,
    durationSeconds: fields.durationSeconds ?? null,
  };
}

/**
 * Folds normalized session events into the transcript items the chat already
 * renders plus the session's lifecycle. The fold is pure: it copies and orders
 * its input, never reads the clock, and the same event list always produces the
 * same projection.
 */
export function projectSession(
  threadId: string,
  events: readonly SessionEvent[]
): SessionProjection {
  let lifecycle: SessionLifecycle = 'creating';
  let binding: SessionBinding | null = null;
  let plan: SessionPlan | null = null;
  let usage: SessionUsage | null = null;
  let lastSequence = 0;
  let unknownEventCount = 0;

  const items: ChatItem[] = [];
  const itemIndex = new Map<string, number>();
  const pendingApprovals: SessionApproval[] = [];
  const approvalResolutions: SessionApprovalResolution[] = [];

  const promoteToRunning = () => {
    if (lifecycle === 'creating' || lifecycle === 'attaching') {
      lifecycle = 'running';
    }
  };

  const upsertItem = (item: ChatItem, appendText = false) => {
    const index = itemIndex.get(item.id);
    if (index === undefined) {
      itemIndex.set(item.id, items.length);
      items.push(item);
      return;
    }
    const existing = items[index];
    const next: ChatItem =
      appendText && existing.kind === item.kind
        ? { ...item, text: `${existing.text}${item.text}`, createdAtUnixMs: existing.createdAtUnixMs }
        : { ...item, createdAtUnixMs: existing.createdAtUnixMs };
    items[index] = next;
  };

  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);

  for (const event of ordered) {
    lastSequence = Math.max(lastSequence, event.sequence);

    switch (event.kind) {
      case 'status': {
        lifecycle = event.lifecycle;
        if (event.binding) binding = { ...event.binding };
        if (event.message) {
          if (event.lifecycle === 'failed') {
            upsertItem(
              chatItem(event, 'error', {
                id: `status-error-${event.sequence}`,
                text: event.message,
                title: 'Session failed',
              })
            );
          } else {
            upsertItem(
              chatItem(event, 'note', {
                id: `status-note-${event.sequence}`,
                text: boundedText(event.message, NOTICE_TEXT_LIMIT),
              })
            );
          }
        }
        break;
      }
      case 'text': {
        promoteToRunning();
        upsertItem(
          chatItem(event, 'assistant', {
            id: event.itemId,
            text: event.text,
            streaming: event.streaming ?? false,
          }),
          event.append ?? true
        );
        break;
      }
      case 'reasoning': {
        promoteToRunning();
        upsertItem(
          chatItem(event, 'reasoning', {
            id: event.itemId,
            text: event.text,
            streaming: event.streaming ?? false,
          }),
          event.append ?? true
        );
        break;
      }
      case 'tool': {
        promoteToRunning();
        upsertItem(
          chatItem(event, 'tool', {
            id: event.itemId,
            text: '',
            title: event.title ?? null,
            detail: event.detail ?? null,
            status: event.status ?? null,
            toolName: event.toolName,
            toolKind: event.toolKind ?? null,
            command: event.command ?? null,
            filePath: event.filePath ?? null,
            addedLines: event.addedLines ?? null,
            removedLines: event.removedLines ?? null,
            durationSeconds: event.durationSeconds ?? null,
          })
        );
        break;
      }
      case 'plan': {
        promoteToRunning();
        plan = { ...event.plan };
        break;
      }
      case 'approvalOpened': {
        lifecycle = 'waiting';
        const approval = { ...event.approval };
        const index = pendingApprovals.findIndex((pending) => pending.id === approval.id);
        if (index === -1) pendingApprovals.push(approval);
        else pendingApprovals[index] = approval;
        break;
      }
      case 'approvalResolved': {
        const index = pendingApprovals.findIndex((approval) => approval.id === event.requestId);
        // An unknown or already-settled request never mutates the thread.
        if (index === -1) break;
        pendingApprovals.splice(index, 1);
        approvalResolutions.push({
          requestId: event.requestId,
          decision: event.decision,
          sequence: event.sequence,
        });
        if (event.decision === 'denyAndStop') {
          lifecycle = 'interrupted';
        } else if (lifecycle === 'waiting') {
          lifecycle = pendingApprovals.length > 0 ? 'waiting' : 'running';
        }
        break;
      }
      case 'notice': {
        if (event.code === 'unknownFrame') unknownEventCount += 1;
        upsertItem(
          chatItem(event, 'note', {
            id: `notice-${event.sequence}`,
            text: event.text,
          })
        );
        break;
      }
      case 'error': {
        lifecycle = 'failed';
        upsertItem(
          chatItem(event, 'error', {
            id: `error-${event.sequence}`,
            text: event.text,
            title: event.title ?? null,
          })
        );
        break;
      }
      case 'usage': {
        usage = {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          costUsd: event.usage.costUsd,
          ...(event.usage.durationSeconds === undefined
            ? {}
            : { durationSeconds: event.usage.durationSeconds }),
        };
        break;
      }
    }
  }

  return {
    threadId,
    lifecycle,
    binding,
    items,
    plan,
    pendingApprovals,
    approvalResolutions,
    usage,
    lastSequence,
    unknownEventCount,
  };
}
