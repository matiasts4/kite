/** Atomic @ mention and terminal-excerpt tokens for the composer draft. */

import {
  citationSpans,
  encodeCitation,
  expandCitations,
  type CitationPayload,
} from './citationChip';

export const MENTION_START = '\u{E002}';
export const MENTION_END = '\u{E003}';
export const KITE_MENTION_MIME = 'application/x-kite-mention';
export const KITE_FILES_MIME = 'application/x-kite-files-entry';
export const KITE_THREAD_MIME = 'application/x-kite-thread';

const TOKEN_SOURCE = '\\u{E002}([A-Za-z0-9_-]+)\\u{E003}';
const TOKEN_RE = new RegExp(TOKEN_SOURCE, 'gu');
const TOKEN_EXACT_RE = new RegExp(`^${TOKEN_SOURCE}$`, 'u');

export type MentionKind = 'file' | 'thread' | 'model' | 'terminal';

export interface MentionPayload {
  kind: MentionKind;
  id: string;
  label: string;
  startLine?: number;
  endLine?: number;
}

export interface MentionMenuRow {
  kind: 'file' | 'thread' | 'model';
  id: string;
  label: string;
  menuLabel: string;
}

export interface MentionSources {
  files?: readonly string[];
  threads?: readonly { id: string; title?: string }[];
  models?: readonly string[];
}

export interface MentionSpan {
  start: number;
  end: number;
  token: string;
  mention: MentionPayload;
}

export type ComposerPart =
  | { kind: 'text'; text: string }
  | { kind: 'citation'; token: string; citation: CitationPayload }
  | { kind: 'mention'; token: string; mention: MentionPayload };

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isMentionKind(value: unknown): value is MentionKind {
  return value === 'file' || value === 'thread' || value === 'model' || value === 'terminal';
}

export function encodeMention(payload: MentionPayload): string {
  const body: Record<string, unknown> = {
    k: payload.kind,
    i: payload.id,
    l: payload.label,
  };
  if (typeof payload.startLine === 'number') body.s = payload.startLine;
  if (typeof payload.endLine === 'number') body.e = payload.endLine;
  return `${MENTION_START}${bytesToBase64Url(new TextEncoder().encode(JSON.stringify(body)))}${MENTION_END}`;
}

export function decodeMention(token: string): MentionPayload | null {
  const match = TOKEN_EXACT_RE.exec(token);
  if (!match) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(match[1]))) as {
      k?: unknown;
      i?: unknown;
      l?: unknown;
      s?: unknown;
      e?: unknown;
    };
    if (!isMentionKind(parsed.k) || typeof parsed.i !== 'string') return null;
    const mention: MentionPayload = {
      kind: parsed.k,
      id: parsed.i,
      label: typeof parsed.l === 'string' ? parsed.l : '',
    };
    if (typeof parsed.s === 'number') mention.startLine = parsed.s;
    if (typeof parsed.e === 'number') mention.endLine = parsed.e;
    return mention;
  } catch {
    return null;
  }
}

export function terminalExcerptLabel(input: {
  terminalId: string;
  label?: string;
  startLine: number;
  endLine: number;
}): string {
  const named = input.label?.trim();
  const id = input.terminalId.trim();
  const title = named || (/^terminal\s/i.test(id) ? id : `Terminal ${id}`);
  return `${title} \u00B7 lines ${input.startLine}\u2013${input.endLine}`;
}

export function mentionChipLabel(mention: MentionPayload): string {
  if (mention.kind === 'terminal') {
    return terminalExcerptLabel({
      terminalId: mention.id,
      label: mention.label || undefined,
      startLine: mention.startLine ?? 0,
      endLine: mention.endLine ?? mention.startLine ?? 0,
    });
  }
  if (mention.kind === 'thread') return mention.id;
  return mention.label || mention.id;
}

export function mentionFromTerminalExcerpt(detail: unknown): MentionPayload | null {
  if (!detail || typeof detail !== 'object') return null;
  const record = detail as {
    terminalId?: unknown;
    label?: unknown;
    startLine?: unknown;
    endLine?: unknown;
  };
  if (typeof record.terminalId !== 'string' || record.terminalId.trim().length === 0) return null;
  if (typeof record.startLine !== 'number' || typeof record.endLine !== 'number') return null;
  if (!Number.isFinite(record.startLine) || !Number.isFinite(record.endLine)) return null;
  return {
    kind: 'terminal',
    id: record.terminalId,
    label: typeof record.label === 'string' ? record.label : '',
    startLine: record.startLine,
    endLine: record.endLine,
  };
}

export function mentionSpans(draft: string): MentionSpan[] {
  const spans: MentionSpan[] = [];
  for (const match of draft.matchAll(TOKEN_RE)) {
    if (match.index === undefined) continue;
    const token = match[0];
    const mention = decodeMention(token);
    if (!mention) continue;
    spans.push({ start: match.index, end: match.index + token.length, token, mention });
  }
  return spans;
}

export function draftHasMention(draft: string): boolean {
  return mentionSpans(draft).length > 0;
}

export function expandMentions(text: string): string {
  return text.replace(TOKEN_RE, (token) => {
    const mention = decodeMention(token);
    return mention ? mentionMarkdown(mention) : token;
  });
}

export function mentionMarkdown(mention: MentionPayload): string {
  return `[${mentionChipLabel(mention)}](${mentionHref(mention)})`;
}

function mentionHref(mention: MentionPayload): string {
  if (mention.kind === 'file') return mention.id;
  if (mention.kind === 'thread') return `thread:${mention.id}`;
  if (mention.kind === 'model') return `model:${mention.id}`;
  const start = mention.startLine ?? 0;
  const end = mention.endLine ?? start;
  return `terminal:${mention.id}#L${start}-L${end}`;
}

export function mentionClipboard(text: string): { inApp: string; external: string } {
  return { inApp: text, external: expandMentions(expandCitations(text)) };
}

export function writeMentionClipboard(data: DataTransfer, text: string): void {
  const channels = mentionClipboard(text);
  data.setData('text/plain', channels.external);
  data.setData(KITE_MENTION_MIME, channels.inApp);
}

export function readMentionClipboard(data: DataTransfer): string | null {
  if (typeof data.getData !== 'function') return null;
  let kite = '';
  try {
    kite = data.getData(KITE_MENTION_MIME);
  } catch {
    return null;
  }
  return kite && draftHasMention(kite) ? kite : null;
}

export function filterMentionMenu(query: string, sources: MentionSources = {}): MentionMenuRow[] {
  const needle = query.trim().toLowerCase();
  const matches = (value: string) => needle.length === 0 || value.toLowerCase().includes(needle);
  const files = (sources.files ?? [])
    .filter((file) => matches(file))
    .map((file) => ({ kind: 'file' as const, id: file, label: file, menuLabel: file }));
  const threads = (sources.threads ?? [])
    .filter((thread) => matches(thread.id) || matches(thread.title ?? ''))
    .map((thread) => ({
      kind: 'thread' as const,
      id: thread.id,
      label: thread.id,
      menuLabel: thread.title?.trim() || thread.id,
    }));
  const models = (sources.models ?? [])
    .filter((model) => matches(model))
    .map((model) => ({ kind: 'model' as const, id: model, label: model, menuLabel: model }));
  return [...files, ...threads, ...models];
}

export function mentionQueryAt(draft: string, caret: number): { start: number; query: string } | null {
  const safe = Math.max(0, Math.min(caret, draft.length));
  if (composerChipSpans(draft).some((span) => safe > span.start && safe < span.end)) return null;
  const upto = draft.slice(0, safe);
  const match = upto.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match || match.index === undefined) return null;
  const at = match.index + (upto[match.index] === '@' ? 0 : 1);
  return { start: at, query: match[1] ?? '' };
}

export function insertMentionAtCaret(
  draft: string,
  start: number,
  end: number,
  mention: MentionPayload,
): { text: string; caret: number } {
  const safeStart = Math.max(0, Math.min(start, draft.length));
  const safeEnd = Math.max(safeStart, Math.min(end, draft.length));
  const token = encodeMention(mention);
  return {
    text: draft.slice(0, safeStart) + token + draft.slice(safeEnd),
    caret: safeStart + token.length,
  };
}

export function insertThreadReference<T>(
  threads: readonly T[],
  draft: string,
  start: number,
  end: number,
  thread: { id: string; title?: string },
): { text: string; caret: number; threads: readonly T[] } {
  const inserted = insertMentionAtCaret(draft, start, end, {
    kind: 'thread',
    id: thread.id,
    label: thread.id,
  });
  return { text: inserted.text, caret: inserted.caret, threads };
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : '';
}

export function mentionFromDrop(mime: string, raw: string): MentionPayload | null {
  if (mime === KITE_THREAD_MIME) return threadFromRaw(raw);
  if (mime === KITE_FILES_MIME) return fileFromRaw(raw);
  return null;
}

function fileFromRaw(raw: string): MentionPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const path =
        stringField(record, 'relativePath') ||
        stringField(record, 'path') ||
        stringField(record, 'name') ||
        stringField(record, 'entryId');
      if (!path) return null;
      return { kind: 'file', id: path, label: path };
    }
  } catch {
    // A non-JSON payload is still a file id, never an @path string.
  }
  return { kind: 'file', id: trimmed, label: trimmed };
}

function threadFromRaw(raw: string): MentionPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { id?: unknown; threadId?: unknown };
      const id = typeof parsed.id === 'string' ? parsed.id : typeof parsed.threadId === 'string' ? parsed.threadId : '';
      if (id.trim()) return { kind: 'thread', id: id.trim(), label: id.trim() };
    } catch {
      // Fall through to the plain thread id.
    }
  }
  return { kind: 'thread', id: trimmed, label: trimmed };
}

export function insertDropAtCaret(
  draft: string,
  start: number,
  end: number,
  mime: string,
  raw: string,
): { text: string; caret: number } | null {
  const mention = mentionFromDrop(mime, raw);
  if (!mention) return null;
  return insertMentionAtCaret(draft, start, end, mention);
}

interface ChipSpan {
  start: number;
  end: number;
}

function composerChipSpans(draft: string): ChipSpan[] {
  return [
    ...citationSpans(draft).map((span) => ({ start: span.start, end: span.end })),
    ...mentionSpans(draft).map((span) => ({ start: span.start, end: span.end })),
  ].sort((left, right) => left.start - right.start);
}

function deleteChipKey(
  spans: ChipSpan[],
  draft: string,
  selectionStart: number,
  selectionEnd: number,
  key: 'Backspace' | 'Delete',
): { text: string; caret: number } | null {
  const start = Math.max(0, Math.min(selectionStart, draft.length));
  const end = Math.max(start, Math.min(selectionEnd, draft.length));
  if (start !== end) {
    const touched = spans.filter((span) => span.start < end && span.end > start);
    if (touched.length === 0) return null;
    const cutStart = Math.min(start, ...touched.map((span) => span.start));
    const cutEnd = Math.max(end, ...touched.map((span) => span.end));
    return { text: draft.slice(0, cutStart) + draft.slice(cutEnd), caret: cutStart };
  }
  const hit =
    key === 'Backspace'
      ? spans.find((span) => start > span.start && start <= span.end)
      : spans.find((span) => start >= span.start && start < span.end);
  if (!hit) return null;
  return { text: draft.slice(0, hit.start) + draft.slice(hit.end), caret: hit.start };
}

export function deleteMentionKey(
  draft: string,
  selectionStart: number,
  selectionEnd: number,
  key: 'Backspace' | 'Delete',
): { text: string; caret: number } | null {
  return deleteChipKey(mentionSpans(draft), draft, selectionStart, selectionEnd, key);
}

export function deleteComposerChipKey(
  draft: string,
  selectionStart: number,
  selectionEnd: number,
  key: 'Backspace' | 'Delete',
): { text: string; caret: number } | null {
  return deleteChipKey(composerChipSpans(draft), draft, selectionStart, selectionEnd, key);
}

export function splitComposerDraft(draft: string): ComposerPart[] {
  const spans = [
    ...citationSpans(draft).map((span) => ({
      kind: 'citation' as const,
      start: span.start,
      end: span.end,
      token: span.token,
      citation: span.citation,
    })),
    ...mentionSpans(draft).map((span) => ({
      kind: 'mention' as const,
      start: span.start,
      end: span.end,
      token: span.token,
      mention: span.mention,
    })),
  ].sort((left, right) => left.start - right.start);
  if (spans.length === 0) return [{ kind: 'text', text: draft }];
  const parts: ComposerPart[] = [];
  let cursor = 0;
  for (const span of spans) {
    parts.push({ kind: 'text', text: draft.slice(cursor, span.start) });
    if (span.kind === 'citation') {
      parts.push({ kind: 'citation', token: span.token, citation: span.citation });
    } else {
      parts.push({ kind: 'mention', token: span.token, mention: span.mention });
    }
    cursor = span.end;
  }
  parts.push({ kind: 'text', text: draft.slice(cursor) });
  return parts;
}

export function joinComposerDraft(parts: ComposerPart[]): string {
  return parts
    .map((part) => (part.kind === 'text' ? part.text : part.token))
    .join('');
}

export function composerPartOffset(parts: ComposerPart[], index: number): number {
  let offset = 0;
  for (let i = 0; i < index && i < parts.length; i += 1) {
    const part = parts[i];
    offset += part.kind === 'text' ? part.text.length : part.token.length;
  }
  return offset;
}

export function replaceComposerTextPart(draft: string, partIndex: number, nextText: string): string {
  const parts = splitComposerDraft(draft);
  if (parts[partIndex]?.kind !== 'text') return draft;
  parts[partIndex] = { kind: 'text', text: nextText };
  return joinComposerDraft(parts);
}

export function removeComposerPart(draft: string, partIndex: number): string {
  const parts = splitComposerDraft(draft);
  const part = parts[partIndex];
  if (!part || part.kind === 'text') return draft;
  parts.splice(partIndex, 1);
  return joinComposerDraft(parts);
}

export function replaceComposerCitationComment(draft: string, partIndex: number, comment: string): string {
  const parts = splitComposerDraft(draft);
  const part = parts[partIndex];
  if (part?.kind !== 'citation') return draft;
  const citation = { ...part.citation, comment };
  const token = encodeCitation(citation);
  parts[partIndex] = { kind: 'citation', token, citation };
  return joinComposerDraft(parts);
}
