import type { ChatItem } from '../../../types';
import { dedupeSubagentItems } from './subagentRunHelpers';

const QUIET_NOTICE_RE =
  /(?:^|\n|\s*)The provider has not sent an update\.\s*(?:Stop the turn if this stays quiet\.)?\s*/gi;

const LAUNCH_PREAMBLE_RE =
  /^\s*(?:Lancé el subagente[\s\S]*?Estoy esperando su respuesta\.?|I launched the subagent[\s\S]*?Waiting for its response\.?)(?:\s+|(?=\n))/i;

export function sanitizeAssistantProtocolText(rawText: string): string {
  const withoutProtocolBlobs = rawText
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

export function liveThoughtLine(markdown?: string | null): string {
  if (!markdown) return '';
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/.exec(markdown)?.[1];
  const text = (heading ?? markdown)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, '')
    .replace(/`+|\*\*|~~/g, '')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (heading !== undefined) return text;
  const end = /[.?!]["'”’)]?(?=\s)/.exec(text);
  return end ? text.slice(0, end.index + end[0].length) : text;
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

export function groupTranscriptRows(items: ChatItem[]): TranscriptRow[] {
  const result: TranscriptRow[] = [];
  let currentWork: ChatItem[] = [];
  let currentSubagents: ChatItem[] = [];

  const flushWork = () => {
    if (currentWork.length > 0) {
      result.push({
        kind: 'work',
        id: `work-${currentWork[0]?.id ?? result.length}`,
        items: currentWork,
      });
      currentWork = [];
    }
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
    if ((item.kind !== 'assistant' && item.kind !== 'reasoning') || item.text.length !== 0) {
      flushWork();
      result.push({ kind: 'item', item });
    }
  }
  flushSubagents();
  flushWork();
  return result;
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
