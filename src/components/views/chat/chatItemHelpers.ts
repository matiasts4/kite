import type { ChatItem } from '../../../types';
import { liveThoughtLine } from './activityPresentation';
import {
  dedupeSubagentItems,
  isHookBlockedInvokeNoise,
  isItemFailed,
  isZeroStepUnbackedFailedItem,
} from './subagentRunHelpers';

export { liveThoughtLine };

const KITE_ENVELOPE_AGENT_HEADER = '\nThis is another agent, not the person.\n';

/** Matches agent-to-agent dispatch envelopes and Swarm coordinator wakeups stored as user turns. */
export function isInternalDispatchPromptText(rawText: string | null | undefined): boolean {
  const normalized = (rawText ?? '').replace(/\r\n/g, '\n').trimStart();
  if (
    normalized.startsWith('[kite from="') &&
    normalized.includes(KITE_ENVELOPE_AGENT_HEADER) &&
    (normalized.includes('\nBODY:\n') || normalized.endsWith('\nBODY:'))
  ) {
    return true;
  }
  return normalized.startsWith('[Swarm Coordinator Wakeup — ');
}

/** Returns true when a ChatItem represents an internal orchestrator wakeup rather than a human prompt. */
export function isInternalDispatchItem(item: ChatItem | null | undefined): boolean {
  if (!item || item.kind !== 'user') return false;
  return Boolean(item.internalDispatch) || isInternalDispatchPromptText(item.text);
}

export const QUIET_TURN_NOTE_TEXT =
  'The provider has not sent an update. Stop the turn if this stays quiet.';

const QUIET_NOTICE_RE =
  /(?:^|\n|\s*)The provider has not sent an update\.\s*(?:Stop the turn if this stays quiet\.)?\s*/gi;

const LAUNCH_PREAMBLE_RE =
  /^\s*(?:Lancé el subagente[\s\S]*?Estoy esperando su respuesta\.?|I launched the subagent[\s\S]*?Waiting for its response\.?)(?:\s+|(?=\n))/i;

const SYSTEM_MESSAGE_CASE1_HEADER =
  'The following is a <SYSTEM_MESSAGE> not actually sent by the user';
const SYSTEM_MESSAGE_OPEN_TAG = '<SYSTEM_MESSAGE>';
const SYSTEM_MESSAGE_CLOSE_TAG = '</SYSTEM_MESSAGE>';

function hasNewlineThenMessageTag(afterOpen: string): boolean {
  let i = 0;
  while (i < afterOpen.length && (afterOpen[i] === ' ' || afterOpen[i] === '\t')) {
    i++;
  }
  if (afterOpen.slice(i, i + 2) === '\r\n') {
    i += 2;
  } else if (afterOpen[i] === '\n') {
    i += 1;
  } else {
    return false;
  }
  while (i < afterOpen.length) {
    while (i < afterOpen.length && (afterOpen[i] === ' ' || afterOpen[i] === '\t')) {
      i++;
    }
    if (afterOpen.slice(i, i + 2) === '\r\n') {
      i += 2;
      continue;
    }
    if (afterOpen[i] === '\n') {
      i += 1;
      continue;
    }
    return afterOpen.startsWith('[Message]', i);
  }
  return false;
}

function findSystemMessageEnvelope(
  s: string,
  from: number,
): { blockStart: number; blockEnd: number } | null {
  let pos1 = from;
  let case1: { start: number; afterHeader: number } | null = null;
  while (pos1 < s.length) {
    const idx = s.indexOf(SYSTEM_MESSAGE_CASE1_HEADER, pos1);
    if (idx < 0) break;
    if (idx > 0 && s[idx - 1] === '`') {
      pos1 = idx + SYSTEM_MESSAGE_CASE1_HEADER.length;
      continue;
    }
    case1 = { start: idx, afterHeader: idx + SYSTEM_MESSAGE_CASE1_HEADER.length };
    break;
  }

  let pos2 = from;
  let case2: { start: number; afterHeader: number } | null = null;
  while (pos2 < s.length) {
    const idx = s.indexOf(SYSTEM_MESSAGE_OPEN_TAG, pos2);
    if (idx < 0) break;
    if (idx > 0 && s[idx - 1] === '`') {
      pos2 = idx + SYSTEM_MESSAGE_OPEN_TAG.length;
      continue;
    }
    const afterOpenIdx = idx + SYSTEM_MESSAGE_OPEN_TAG.length;
    if (hasNewlineThenMessageTag(s.slice(afterOpenIdx))) {
      case2 = { start: idx, afterHeader: afterOpenIdx };
      break;
    }
    pos2 = afterOpenIdx;
  }

  const chosen =
    case1 && case2 ? (case1.start <= case2.start ? case1 : case2) : case1 ?? case2;
  if (!chosen) return null;

  let blockStart = chosen.start;
  if (chosen.start > 0 && s[chosen.start - 1] === '\n') {
    const beforeNlEnd =
      chosen.start >= 2 && s[chosen.start - 2] === '\r'
        ? chosen.start - 2
        : chosen.start - 1;
    const prevNl = s.lastIndexOf('\n', beforeNlEnd - 1);
    const lineStart = prevNl >= 0 ? prevNl + 1 : 0;
    if (s.slice(lineStart, beforeNlEnd).trim() === 'user') {
      blockStart = lineStart;
    }
  }

  const closeIdx = s.indexOf(SYSTEM_MESSAGE_CLOSE_TAG, chosen.afterHeader);
  const blockEnd =
    closeIdx >= 0 ? closeIdx + SYSTEM_MESSAGE_CLOSE_TAG.length : s.length;
  return { blockStart, blockEnd };
}

function stripSystemMessageEnvelopes(rawText: string): string {
  let cursor = 0;
  let out = '';
  let strippedAny = false;
  let pendingSeam = false;

  while (cursor < rawText.length) {
    const env = findSystemMessageEnvelope(rawText, cursor);
    if (!env) break;
    const before = rawText.slice(cursor, env.blockStart);
    if (before.trim().length === 0) {
      pendingSeam = true;
    } else {
      if (pendingSeam) {
        out = out.trimEnd();
        if (out.length > 0) out += '\n\n';
        out += before.trimStart();
      } else {
        out += before;
      }
      pendingSeam = true;
    }
    strippedAny = true;
    cursor = env.blockEnd;
  }

  if (!strippedAny) return rawText;

  const tail = rawText.slice(cursor);
  if (tail.trim().length === 0) {
    return out.trimEnd();
  }
  if (pendingSeam) {
    out = out.trimEnd();
    if (out.length > 0) out += '\n\n';
    out += tail.trimStart();
  } else {
    out += tail;
  }
  return out;
}

export function sanitizeAssistantProtocolText(rawText: string): string {
  const withoutSystemEnvelopes = stripSystemMessageEnvelopes(rawText);
  if (withoutSystemEnvelopes.length === 0) {
    return '';
  }

  const withoutProtocolBlobs = withoutSystemEnvelopes
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        if (
          trimmed.includes('"type"') &&
          (trimmed.includes('"step-finish"') ||
            trimmed.includes('"step_finish"') ||
            trimmed.includes('"tool-call"') ||
            trimmed.includes('"tokens"') ||
            trimmed.includes('"sessionID"'))
        ) {
          return false;
        }
      }
      return true;
    })
    .join('\n');

  let cleaned = withoutProtocolBlobs;
  const withoutQuiet = cleaned.replace(QUIET_NOTICE_RE, '\n').trim();
  if (withoutQuiet.length > 0) {
    cleaned = withoutQuiet;
  }
  const withoutLaunchPreamble = cleaned.replace(LAUNCH_PREAMBLE_RE, '');
  if (withoutLaunchPreamble.trim().length > 0) {
    cleaned = withoutLaunchPreamble;
  }
  return cleaned;
}

/** Unwraps `<proposed_plan>` containers and strips internal protocol noise from assistant text. */
export function visibleAssistantText(rawText: string): string {
  const unwrapped = rawText.replace(/<\/?proposed_plan>/g, (match, offset, full) => {
    const before = offset > 0 ? full[offset - 1] : '';
    const after = full[offset + match.length] ?? '';
    return before === '`' && after === '`' ? match : '\n';
  });
  return sanitizeAssistantProtocolText(unwrapped);
}

/** Returns true when a `note` item renders nothing visible in the transcript. */
export function isHiddenNoteItem(item: ChatItem | null | undefined): boolean {
  if (!item || item.kind !== 'note') return false;
  const trimmed = item.text.trim();
  if (trimmed.length === 0) return true;
  return !item.streaming && trimmed === QUIET_TURN_NOTE_TEXT;
}

export function userMessageFolds(text: string): boolean {
  return text.length > 500 || text.split('\n').length > 12;
}

/** Preview after the headline, so a streaming row does not repeat the same sentence. */
export function reasoningPreviewRemainder(text: string, summary: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!summary || flat === summary) return '';
  if (flat.startsWith(summary)) return flat.slice(summary.length).trim();
  return flat;
}

export type TranscriptRow =
  | { kind: 'work'; id: string; items: ChatItem[] }
  | { kind: 'subagentGroup'; id: string; items: ChatItem[] }
  | { kind: 'item'; item: ChatItem };

function isSubagentItem(item: ChatItem): boolean {
  return (
    (item.kind === 'tool' || item.kind === 'command') &&
    (item.toolKind === 'subagent' || Boolean(item.subagentMeta)) &&
    item.toolKind !== 'swarm' &&
    !item.swarmMeta
  );
}

function isSwarmItem(item: ChatItem): boolean {
  return (
    (item.kind === 'tool' || item.kind === 'command') &&
    (item.toolKind === 'swarm' || Boolean(item.swarmMeta))
  );
}

function isUngroupedSubagentOrSwarm(item: ChatItem): boolean {
  return isSubagentItem(item) || isSwarmItem(item);
}

const RENDERED_CHAT_KINDS = new Set([
  'user',
  'assistant',
  'reasoning',
  'tool',
  'command',
  'error',
  'note',
  'quotaHandoff',
]);

function isNonRenderedTranscriptItem(item: ChatItem): boolean {
  if (isInternalDispatchItem(item)) return true;
  const rawKind = String((item as { kind?: unknown }).kind ?? '');
  if (!RENDERED_CHAT_KINDS.has(rawKind)) return true;
  if (item.kind === 'note' && isHiddenNoteItem(item)) return true;
  if (item.kind === 'reasoning' && item.text.trim().length === 0) return true;
  if (item.kind === 'assistant' && visibleAssistantText(item.text).trim().length === 0) {
    return true;
  }
  if (item.kind === 'quotaHandoff' && !item.handoffOffer) return true;
  if (isSubagentItem(item) && isHookBlockedInvokeNoise(item)) return true;
  return false;
}

const MAX_CACHED_GROUPED_ROWS = 1024;
const lastGroupedRowsById = new Map<string, TranscriptRow>();

function areItemRefsEqual(a: readonly ChatItem[], b: readonly ChatItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function stabilizeTranscriptRows(rows: TranscriptRow[]): TranscriptRow[] {
  if (lastGroupedRowsById.size > MAX_CACHED_GROUPED_ROWS) {
    lastGroupedRowsById.clear();
  }
  return rows.map((row) => {
    const key = row.kind === 'item' ? `item:${row.item.id}` : row.id;
    const prev = lastGroupedRowsById.get(key);
    let chosen: TranscriptRow = row;
    if (prev && prev.kind === row.kind) {
      if (row.kind === 'item' && prev.kind === 'item' && prev.item === row.item) {
        chosen = prev;
      } else if (
        (row.kind === 'work' && prev.kind === 'work' && areItemRefsEqual(prev.items, row.items)) ||
        (row.kind === 'subagentGroup' &&
          prev.kind === 'subagentGroup' &&
          areItemRefsEqual(prev.items, row.items))
      ) {
        chosen = prev;
      }
    }
    lastGroupedRowsById.set(key, chosen);
    return chosen;
  });
}

/**
 * Identifies 0-step unbacked failed subagent attempts in a turn that are superseded by
 * another non-failed or step-bearing subagent in the same user-to-user turn.
 */
function findSupersededTurnNoiseIds(items: readonly ChatItem[]): Set<string> {
  const suppressed = new Set<string>();
  let turnSubagents: ChatItem[] = [];

  const flushTurn = () => {
    if (turnSubagents.length > 1) {
      const hasRealSubagent = turnSubagents.some(
        (it) => !isItemFailed(it) || (it.subagentMeta?.stepCount ?? 0) > 0,
      );
      if (hasRealSubagent) {
        for (const it of turnSubagents) {
          if (isZeroStepUnbackedFailedItem(it)) {
            suppressed.add(it.id);
          }
        }
      }
    }
    turnSubagents = [];
  };

  for (const item of items) {
    if (item.kind === 'user' && !isInternalDispatchItem(item)) {
      flushTurn();
      continue;
    }
    if (isSubagentItem(item) && !isHookBlockedInvokeNoise(item)) {
      turnSubagents.push(item);
    }
  }
  flushTurn();
  return suppressed;
}

export function groupTranscriptRows(items: ChatItem[]): TranscriptRow[] {
  const supersededNoiseIds = findSupersededTurnNoiseIds(items);
  const result: TranscriptRow[] = [];
  let currentWork: ChatItem[] = [];
  let currentSubagents: ChatItem[] = [];

  const flushWork = () => {
    if (currentWork.length === 0) return;
    const hasToolOrCommand = currentWork.some(
      (entry) => entry.kind === 'tool' || entry.kind === 'command',
    );
    if (hasToolOrCommand) {
      result.push({
        kind: 'work',
        id: `work-${currentWork[0]?.id ?? result.length}`,
        items: currentWork,
      });
    } else {
      for (const entry of currentWork) {
        result.push({ kind: 'item', item: entry });
      }
    }
    currentWork = [];
  };

  const flushSubagents = () => {
    const deduped = dedupeSubagentItems(currentSubagents);
    if (deduped.length >= 2) {
      result.push({
        kind: 'subagentGroup',
        id: `subagents-${deduped[0]?.id ?? result.length}`,
        items: deduped,
      });
    } else if (deduped.length === 1) {
      result.push({ kind: 'item', item: deduped[0] });
    }
    currentSubagents = [];
  };

  for (const item of items) {
    // Non-rendered items (notices, hidden quiet notes, empty/protocol assistant chunks, suppressed noise) must not split active or settled bursts.
    if (isNonRenderedTranscriptItem(item) || supersededNoiseIds.has(item.id)) {
      continue;
    }
    if (isSubagentItem(item)) {
      flushWork();
      currentSubagents.push(item);
      continue;
    }
    flushSubagents();
    if (item.kind === 'tool' || item.kind === 'command') {
      if (isSwarmItem(item)) {
        flushWork();
        result.push({ kind: 'item', item });
        continue;
      }
      currentWork.push(item);
      continue;
    }
    if (item.kind === 'reasoning') {
      currentWork.push(item);
      continue;
    }
    flushWork();
    result.push({ kind: 'item', item });
  }
  flushSubagents();
  flushWork();
  return stabilizeTranscriptRows(result);
}

/** Index of the trailing action group, so the working caption sits above it. */
export function liveActivityRowIndex(rows: TranscriptRow[]): number {
  const last = rows[rows.length - 1];
  if (!last) return -1;
  if (last.kind === 'work' || last.kind === 'subagentGroup') return rows.length - 1;
  if (
    last.kind === 'item' &&
    (last.item.kind === 'reasoning' || isUngroupedSubagentOrSwarm(last.item))
  ) {
    return rows.length - 1;
  }
  return -1;
}
