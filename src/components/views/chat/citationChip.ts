/** Atomic assistant-citation tokens for the composer draft string. */

export const CITATION_START = '\u{E000}';
export const CITATION_END = '\u{E001}';
export const KITE_CITATION_MIME = 'application/x-kite-citation';
export const CITATION_PREVIEW_LIMIT = 48;

const TOKEN_SOURCE = '\\u{E000}([A-Za-z0-9_-]+)\\u{E001}';
const TOKEN_RE = new RegExp(TOKEN_SOURCE, 'gu');
const TOKEN_EXACT_RE = new RegExp(`^${TOKEN_SOURCE}$`, 'u');

export interface CitationPayload {
  messageId: string;
  quote: string;
  comment: string;
}

export type CitationInput =
  | string
  | {
      messageId?: string;
      quote?: string;
      comment?: string;
    }
  | null
  | undefined;

export type DraftPart =
  | { kind: 'text'; text: string }
  | { kind: 'citation'; token: string; citation: CitationPayload };

export interface CitationSpan {
  start: number;
  end: number;
  token: string;
  citation: CitationPayload;
}

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

export function encodeCitation(payload: CitationPayload): string {
  const json = JSON.stringify({ m: payload.messageId, q: payload.quote, c: payload.comment });
  return `${CITATION_START}${bytesToBase64Url(new TextEncoder().encode(json))}${CITATION_END}`;
}

export function decodeCitation(token: string): CitationPayload | null {
  const match = TOKEN_EXACT_RE.exec(token);
  if (!match) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(match[1]))) as {
      m?: unknown;
      q?: unknown;
      c?: unknown;
    };
    if (typeof parsed.q !== 'string') return null;
    return {
      messageId: typeof parsed.m === 'string' ? parsed.m : '',
      quote: parsed.q,
      comment: typeof parsed.c === 'string' ? parsed.c : '',
    };
  } catch {
    return null;
  }
}

export function normalizeCitation(input: CitationInput | unknown): CitationPayload | null {
  if (typeof input === 'string') {
    const quote = input.trim();
    return quote ? { messageId: '', quote, comment: '' } : null;
  }
  if (!input || typeof input !== 'object') return null;
  const record = input as { messageId?: unknown; quote?: unknown; comment?: unknown };
  const quote = typeof record.quote === 'string' ? record.quote.trim() : '';
  if (!quote) return null;
  return {
    messageId: typeof record.messageId === 'string' ? record.messageId : '',
    quote,
    comment: typeof record.comment === 'string' ? record.comment : '',
  };
}

export function citationSpans(draft: string): CitationSpan[] {
  const spans: CitationSpan[] = [];
  for (const match of draft.matchAll(TOKEN_RE)) {
    if (match.index === undefined) continue;
    const token = match[0];
    const citation = decodeCitation(token);
    if (!citation) continue;
    spans.push({ start: match.index, end: match.index + token.length, token, citation });
  }
  return spans;
}

export function draftHasCitation(draft: string): boolean {
  return citationSpans(draft).length > 0;
}

export function splitDraft(draft: string): DraftPart[] {
  const spans = citationSpans(draft);
  if (spans.length === 0) return [{ kind: 'text', text: draft }];
  const parts: DraftPart[] = [];
  let cursor = 0;
  for (const span of spans) {
    parts.push({ kind: 'text', text: draft.slice(cursor, span.start) });
    parts.push({ kind: 'citation', token: span.token, citation: span.citation });
    cursor = span.end;
  }
  parts.push({ kind: 'text', text: draft.slice(cursor) });
  return parts;
}

export function joinDraft(parts: DraftPart[]): string {
  return parts.map((part) => (part.kind === 'text' ? part.text : part.token)).join('');
}

export function draftPartOffset(parts: DraftPart[], index: number): number {
  let offset = 0;
  for (let i = 0; i < index && i < parts.length; i += 1) {
    const part = parts[i];
    offset += part.kind === 'text' ? part.text.length : part.token.length;
  }
  return offset;
}

export function replaceTextPart(draft: string, partIndex: number, nextText: string): string {
  const parts = splitDraft(draft);
  if (parts[partIndex]?.kind !== 'text') return draft;
  parts[partIndex] = { kind: 'text', text: nextText };
  return joinDraft(parts);
}

export function removeDraftPart(draft: string, partIndex: number): string {
  const parts = splitDraft(draft);
  if (parts[partIndex]?.kind !== 'citation') return draft;
  parts.splice(partIndex, 1);
  return joinDraft(parts);
}

export function expandCitation(citation: Pick<CitationPayload, 'quote' | 'comment'>): string {
  const quoted = citation.quote.replace(/\r\n/g, '\n').split('\n').map((line) => `> ${line}`).join('\n');
  return citation.comment.length > 0 ? `${quoted}\n${citation.comment}` : quoted;
}

export function expandCitations(text: string): string {
  return text.replace(TOKEN_RE, (token) => {
    const citation = decodeCitation(token);
    return citation ? expandCitation(citation) : token;
  });
}

export function citationSendLength(text: string): number {
  return expandCitations(text).length;
}

export function citationChipLabel(citation: Pick<CitationPayload, 'quote' | 'comment'>): string {
  const note = citation.comment.trim();
  if (note) return note;
  const flat = citation.quote.replace(/\s+/g, ' ').trim();
  if (flat.length <= CITATION_PREVIEW_LIMIT) return flat;
  return `${flat.slice(0, CITATION_PREVIEW_LIMIT - 1)}…`;
}

export function insertCitationAtCaret(
  draft: string,
  start: number,
  end: number,
  citation: CitationInput | unknown,
): { text: string; caret: number } {
  const safeStart = Math.max(0, Math.min(start, draft.length));
  const safeEnd = Math.max(safeStart, Math.min(end, draft.length));
  const payload = normalizeCitation(citation);
  if (!payload) return { text: draft, caret: safeStart };
  const token = encodeCitation(payload);
  return {
    text: draft.slice(0, safeStart) + token + draft.slice(safeEnd),
    caret: safeStart + token.length,
  };
}

export function deleteCitationKey(
  draft: string,
  selectionStart: number,
  selectionEnd: number,
  key: 'Backspace' | 'Delete',
): { text: string; caret: number } | null {
  const spans = citationSpans(draft);
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

export function replaceCitationComment(draft: string, token: string, comment: string): string {
  const citation = decodeCitation(token);
  if (!citation) return draft;
  return draft.replace(token, encodeCitation({ ...citation, comment }));
}

export function replaceCitationCommentAt(draft: string, partIndex: number, comment: string): string {
  const parts = splitDraft(draft);
  const part = parts[partIndex];
  if (part?.kind !== 'citation') return draft;
  const citation = { ...part.citation, comment };
  parts[partIndex] = { kind: 'citation', token: encodeCitation(citation), citation };
  return joinDraft(parts);
}

export function clipboardChannels(text: string): { inApp: string; external: string } {
  return { inApp: text, external: expandCitations(text) };
}

/** The saved quote stays readable when there is no source id, or the source node is gone. */
export function readableQuoteWithoutSource(
  citation: Pick<CitationPayload, 'messageId' | 'quote'>,
  sourcePresent = false,
): string | null {
  if (citation.messageId && sourcePresent) return null;
  return citation.quote;
}

export function locateCitationSource(messageId: string, root: ParentNode = document): Element | null {
  if (!messageId) return null;
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(messageId)
      : messageId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const byAttr = root.querySelector(`[data-message-id="${escaped}"]`);
  if (byAttr) return byAttr;
  if (root instanceof Document) return root.getElementById(messageId);
  if (root instanceof Element && root.id === messageId) return root;
  return root.querySelector(`[id="${escaped}"]`);
}

export function highlightCitationSource(node: Element): void {
  node.classList.add('chat-citation-highlight');
  window.setTimeout(() => node.classList.remove('chat-citation-highlight'), 1600);
}

export function revealCitationSource(messageId: string, root: ParentNode = document): boolean {
  const node = locateCitationSource(messageId, root);
  if (!(node instanceof HTMLElement)) return false;
  if (typeof node.scrollIntoView === 'function') {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    node.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }
  highlightCitationSource(node);
  return true;
}

export function writeCitationClipboard(data: DataTransfer, text: string): void {
  const channels = clipboardChannels(text);
  data.setData('text/plain', channels.external);
  data.setData(KITE_CITATION_MIME, channels.inApp);
}

export function readCitationClipboard(data: DataTransfer): string | null {
  if (typeof data.getData !== 'function') return null;
  let kite = '';
  try {
    kite = data.getData(KITE_CITATION_MIME);
  } catch {
    return null;
  }
  return kite && draftHasCitation(kite) ? kite : null;
}

export function citationTextFromNodes(root: ParentNode): string {
  let text = '';
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? '';
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const token = node.getAttribute('data-citation-token');
    if (token) {
      text += token;
      return;
    }
    text += citationTextFromNodes(node);
  });
  return text;
}
