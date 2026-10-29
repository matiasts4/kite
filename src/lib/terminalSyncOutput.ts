import type { Terminal } from '@xterm/xterm';

/**
 * Maximum time (1 animation frame) to hold an incomplete DEC 2026 synchronized
 * frame before flushing it to xterm.
 */
export const SYNC_OUTPUT_MAX_HOLD_MS = 16;
export const SYNC_OUTPUT_MAX_BUFFER_BYTES = 262_144;

export const ALT_SCREEN_ENTER_SEQUENCE = '\x1b[?1049h';
export const ALT_SCREEN_EXIT_SEQUENCE = '\x1b[?1049l';
const ALT_SCREEN_SEQUENCE_LENGTH = ALT_SCREEN_ENTER_SEQUENCE.length;

const CURSOR_SHOW = '\x1b[?25h';
const CURSOR_HIDE = '\x1b[?25l';
const SYNC_END_STR = '\x1b[?2026l';

const START = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x68]);
const END = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x6c]);

const encoder = new TextEncoder();

function copyBytes(data: Uint8Array, start = 0, end = data.length): Uint8Array {
  const out = new Uint8Array(end - start);
  out.set(data.subarray(start, end));
  return out;
}

function asBytes(chunk: Uint8Array | string): Uint8Array {
  const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
  return copyBytes(bytes);
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  if (left.length > 0) out.set(left, 0);
  if (right.length > 0) out.set(right, left.length);
  return out;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || haystack.length < needle.length) return -1;
  const last = haystack.length - needle.length;
  for (let i = 0; i <= last; i += 1) {
    let matches = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        matches = false;
        break;
      }
    }
    if (matches) return i;
  }
  return -1;
}

function suffixPrefixLength(data: Uint8Array, marker: Uint8Array): number {
  const max = Math.min(marker.length - 1, data.length);
  for (let len = max; len > 0; len -= 1) {
    let matches = true;
    for (let i = 0; i < len; i += 1) {
      if (data[data.length - len + i] !== marker[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return len;
  }
  return 0;
}

export interface SyncOutputHold {
  readonly holding: boolean;
  readonly pending: boolean;
  push(chunk: Uint8Array | string): Uint8Array[];
  flush(): Uint8Array | null;
}

export function createSyncOutputHold(): SyncOutputHold {
  let holding = false;
  let buffer: Uint8Array = new Uint8Array(0);

  return {
    get holding() {
      return holding;
    },
    get pending() {
      return buffer.length > 0;
    },
    push(chunk: Uint8Array | string): Uint8Array[] {
      const incoming = asBytes(chunk);
      if (incoming.length === 0 && buffer.length === 0) return [];
      buffer = concat(buffer, incoming);
      const ready: Uint8Array[] = [];

      while (true) {
        if (!holding) {
          const start = indexOf(buffer, START);
          if (start === -1) {
            const keep = suffixPrefixLength(buffer, START);
            const emitLength = buffer.length - keep;
            if (emitLength > 0) {
              ready.push(copyBytes(buffer, 0, emitLength));
              buffer = copyBytes(buffer, emitLength);
            }
            break;
          }
          if (start > 0) {
            ready.push(copyBytes(buffer, 0, start));
            buffer = copyBytes(buffer, start);
          }
          holding = true;
        }

        const end = indexOf(buffer, END);
        if (end === -1) {
          if (buffer.length >= SYNC_OUTPUT_MAX_BUFFER_BYTES) {
            ready.push(buffer);
            buffer = new Uint8Array(0);
            holding = false;
          }
          break;
        }
        const cut = end + END.length;
        ready.push(copyBytes(buffer, 0, cut));
        buffer = copyBytes(buffer, cut);
        holding = false;
      }

      return ready;
    },
    flush(): Uint8Array | null {
      holding = false;
      if (buffer.length === 0) return null;
      const out = buffer;
      buffer = new Uint8Array(0);
      return out;
    },
  };
}

function findCursorPositioningEnd(text: string, fromIndex: number, limit = text.length): number {
  let esc = text.indexOf('\x1b[', fromIndex);
  while (esc !== -1 && esc < limit) {
    let idx = esc + 2;
    while (idx < limit) {
      const ch = text[idx];
      if (ch === 'G' || ch === 'H' || ch === 'f') {
        return idx + 1;
      }
      if ((ch < '0' || ch > '9') && ch !== ';') {
        break;
      }
      idx += 1;
    }
    esc = text.indexOf('\x1b[', esc + 2);
  }
  return -1;
}

export function hasCursorPositioningSequence(text: string): boolean {
  return findCursorPositioningEnd(text, 0, text.length) !== -1;
}

export function shouldStripTransientCursorShows(text: string): boolean {
  const firstHide = text.indexOf(CURSOR_HIDE);
  const lastShow = text.lastIndexOf(CURSOR_SHOW);
  return firstHide !== -1 && lastShow > firstHide && hasCursorPositioningSequence(text);
}

export function stripTransientCursorShows(text: string): string {
  let out = '';
  let cursor = 0;
  let showIndex = text.indexOf(CURSOR_SHOW);
  while (showIndex !== -1) {
    const nextHide = text.indexOf(CURSOR_HIDE, showIndex + CURSOR_SHOW.length);
    const posEnd = findCursorPositioningEnd(
      text,
      showIndex + CURSOR_SHOW.length,
      nextHide === -1 ? text.length : nextHide,
    );
    if (nextHide === -1) {
      if (posEnd === -1) {
        const syncEnd = text.indexOf(SYNC_END_STR, showIndex + CURSOR_SHOW.length);
        if (syncEnd === -1) break;
        out += text.slice(cursor, showIndex);
        out += text.slice(showIndex + CURSOR_SHOW.length, syncEnd + SYNC_END_STR.length);
        out += CURSOR_SHOW;
        cursor = syncEnd + SYNC_END_STR.length;
        showIndex = text.indexOf(CURSOR_SHOW, cursor);
        continue;
      }
      out += text.slice(cursor, showIndex);
      out += text.slice(showIndex + CURSOR_SHOW.length, posEnd);
      out += CURSOR_SHOW;
      cursor = posEnd;
      showIndex = text.indexOf(CURSOR_SHOW, cursor);
    } else {
      out += text.slice(cursor, showIndex);
      cursor = showIndex + CURSOR_SHOW.length;
      showIndex = text.indexOf(CURSOR_SHOW, cursor);
    }
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}

export function splitAlternateScreenEnterChunk(
  data: string,
  tail: string,
  hasPendingResize: boolean,
): {
  splitBeforeChunkOffset: number | null;
  nextTail: string;
} {
  const combined = `${tail}${data}`;
  const nextTail = combined.slice(-(ALT_SCREEN_SEQUENCE_LENGTH - 1));
  if (!hasPendingResize) {
    return { splitBeforeChunkOffset: null, nextTail };
  }
  const matchIndex = combined.indexOf(ALT_SCREEN_ENTER_SEQUENCE);
  if (matchIndex === -1) {
    return { splitBeforeChunkOffset: null, nextTail };
  }
  const splitOffset = matchIndex + ALT_SCREEN_SEQUENCE_LENGTH - tail.length;
  if (splitOffset <= 0 || splitOffset > data.length) {
    return { splitBeforeChunkOffset: null, nextTail };
  }
  return { splitBeforeChunkOffset: splitOffset, nextTail };
}

const CSI_ERASE_IN_DISPLAY_OR_LINE_RE = /\x1b\[\??[0-9;]*[JKX]/;
const CSI_REWRITE_OR_CURSOR_RE = /\x1b\[[?>=]?[0-9;:]*[JKXPLMST@HfGABCDEFda`e]|\x1b[78M]/;
const NON_ASCII_RE = /[\u0080-\uffff]/;
const CSI_SGR_RE = /\x1b\[([0-9;:]*)m/g;
const EMOJI_PRESENTATION_RE = /\p{Emoji_Presentation}/u;
const CROSS_CHUNK_SCAN_TAIL_LENGTH = 24;

export function hasBareCarriageReturn(
  data: string,
  previousEndsWithCarriageReturn = false,
): boolean {
  if (previousEndsWithCarriageReturn && data.length > 0 && data.charCodeAt(0) !== 10) {
    return true;
  }
  for (let i = 0; i < data.length; i += 1) {
    if (data.charCodeAt(i) === 13 && data.charCodeAt(i + 1) !== 10) {
      return true;
    }
  }
  return false;
}

export function foregroundRewriteOutputPrefersRenderRefresh(
  data: string,
  options: {
    previousEndsWithCarriageReturn?: boolean;
    previousScanTail?: string;
  } = {},
): boolean {
  const combined = options.previousScanTail ? `${options.previousScanTail}${data}` : data;
  return (
    data.includes('\b') ||
    hasBareCarriageReturn(data, options.previousEndsWithCarriageReturn) ||
    CSI_REWRITE_OR_CURSOR_RE.test(combined)
  );
}

export function hasSgrBackgroundColor(data: string): boolean {
  if (!data.includes('\x1b[')) return false;
  CSI_SGR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CSI_SGR_RE.exec(data)) !== null) {
    const rawParams = match[1];
    if (!rawParams) continue;
    const tokens = rawParams.split(/[;:]/).map((part) => Number.parseInt(part, 10));
    for (let i = 0; i < tokens.length; i += 1) {
      const code = tokens[i];
      if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107) || code === 48) {
        return true;
      }
      if (code === 38) {
        const mode = tokens[i + 1];
        if (mode === 5) i += 2;
        else if (mode === 2) i += 4;
      }
    }
  }
  return false;
}

function isComplexOrWideRendererCodePoint(cp: number): boolean {
  return (
    (cp >= 0x0590 && cp <= 0x0dff) ||
    (cp >= 0x1100 && cp <= 0x11ff) ||
    cp === 0x200c ||
    cp === 0x200d ||
    (cp >= 0x231a && cp <= 0x27bf) ||
    (cp >= 0x2b00 && cp <= 0x2bff) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe10 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp >= 0x1f000
  );
}

export function hasComplexOrWideUnicode(data: string): boolean {
  if (EMOJI_PRESENTATION_RE.test(data)) return true;
  for (let i = 0; i < data.length; i += 1) {
    const code = data.charCodeAt(i);
    if (code < 0x0590) continue;
    const cp = data.codePointAt(i) ?? code;
    if (cp > 0xffff) i += 1;
    if (isComplexOrWideRendererCodePoint(cp)) {
      return true;
    }
  }
  return false;
}

export function foregroundRendererRiskOutputPrefersRenderRefresh(
  data: string,
  previousScanTail = '',
): boolean {
  const combined = previousScanTail ? `${previousScanTail}${data}` : data;
  return hasSgrBackgroundColor(combined) || hasComplexOrWideUnicode(data);
}

export interface ForegroundOutputScanState {
  endsWithCarriageReturn: boolean;
  scanTail: string;
}

export function classifyForegroundOutputRefresh(
  data: string,
  options: {
    isWindowsConpty?: boolean;
    scanState?: ForegroundOutputScanState;
  } = {},
): {
  forceViewportRefresh: boolean;
  followupViewportRefresh: boolean;
  clearTextureAtlasOnFollowup: boolean;
  stripTransientCursorShows: boolean;
} {
  const isWindowsConpty = options.isWindowsConpty ?? true;
  const previousEndsWithCr = options.scanState?.endsWithCarriageReturn ?? false;
  const previousScanTail = options.scanState?.scanTail ?? '';
  const combined = previousScanTail ? `${previousScanTail}${data}` : data;

  const inPlaceRewrite =
    isWindowsConpty &&
    foregroundRewriteOutputPrefersRenderRefresh(data, {
      previousEndsWithCarriageReturn: previousEndsWithCr,
      previousScanTail,
    });
  const rendererRisk = foregroundRendererRiskOutputPrefersRenderRefresh(data, previousScanTail);
  const clearTextureAtlasOnFollowup =
    isWindowsConpty &&
    NON_ASCII_RE.test(data) &&
    (hasBareCarriageReturn(data, previousEndsWithCr) || CSI_ERASE_IN_DISPLAY_OR_LINE_RE.test(combined));

  if (options.scanState && data.length > 0) {
    options.scanState.endsWithCarriageReturn = data.charCodeAt(data.length - 1) === 13;
    options.scanState.scanTail = combined.slice(-CROSS_CHUNK_SCAN_TAIL_LENGTH);
  }

  const forceViewportRefresh = inPlaceRewrite || rendererRisk;
  return {
    forceViewportRefresh,
    followupViewportRefresh: (isWindowsConpty && inPlaceRewrite) || clearTextureAtlasOnFollowup,
    clearTextureAtlasOnFollowup,
    stripTransientCursorShows: shouldStripTransientCursorShows(data),
  };
}

interface RefreshRowTracker {
  start: number;
  end: number;
  observed: boolean;
  wholeViewport: boolean;
  dispose: () => void;
}

interface BufferSnapshot {
  type: string | null;
  cursorY: number | null;
  baseY: number | null;
  viewportY: number | null;
}

const refreshTrackers = new WeakMap<Terminal, RefreshRowTracker | null>();
const followupRefreshHandles = new WeakMap<
  Terminal,
  { kind: 'raf' | 'timeout'; id: number }
>();

function ensureRefreshRowTracker(term: Terminal): RefreshRowTracker | null {
  const existing = refreshTrackers.get(term);
  if (existing !== undefined) return existing;
  const inputHandler = (
    term as unknown as {
      _core?: {
        _inputHandler?: {
          onRequestRefreshRows?: (
            listener: (range?: { start: number; end: number }) => void,
          ) => { dispose: () => void };
        };
      };
    }
  )._core?._inputHandler;
  const subscribe = inputHandler?.onRequestRefreshRows;
  if (typeof subscribe !== 'function' || !inputHandler) {
    refreshTrackers.set(term, null);
    return null;
  }
  const tracker: RefreshRowTracker = {
    start: 0,
    end: 0,
    observed: false,
    wholeViewport: false,
    dispose: () => {},
  };
  try {
    const sub = subscribe.call(inputHandler, (range) => {
      if (range) {
        if (tracker.observed) {
          tracker.start = Math.min(tracker.start, range.start);
          tracker.end = Math.max(tracker.end, range.end);
        } else {
          tracker.start = range.start;
          tracker.end = range.end;
          tracker.observed = true;
        }
      } else {
        tracker.wholeViewport = true;
        tracker.observed = true;
      }
    });
    tracker.dispose = () => sub.dispose();
  } catch {
    refreshTrackers.set(term, null);
    return null;
  }
  refreshTrackers.set(term, tracker);
  return tracker;
}

function resetRefreshRowTracker(term: Terminal): void {
  const tracker = ensureRefreshRowTracker(term);
  if (!tracker) return;
  tracker.observed = false;
  tracker.wholeViewport = false;
  tracker.start = 0;
  tracker.end = 0;
}

function readObservedRowRange(term: Terminal): { start: number; end: number } | null {
  const tracker = refreshTrackers.get(term);
  if (!tracker || !tracker.observed || tracker.wholeViewport) {
    return null;
  }
  return { start: tracker.start, end: tracker.end };
}

function captureBufferSnapshot(term: Terminal): BufferSnapshot {
  const active = term.buffer?.active;
  return {
    type: typeof active?.type === 'string' ? active.type : null,
    cursorY: typeof active?.cursorY === 'number' ? active.cursorY : null,
    baseY: typeof active?.baseY === 'number' ? active.baseY : null,
    viewportY: typeof active?.viewportY === 'number' ? active.viewportY : null,
  };
}

function didViewportScrollChange(before: BufferSnapshot, after: BufferSnapshot): boolean {
  return (
    after.baseY !== null &&
    after.viewportY !== null &&
    (after.baseY !== before.baseY || after.viewportY !== before.viewportY)
  );
}

function resolveRefreshRowRange(
  term: Terminal,
  before: BufferSnapshot,
  after: BufferSnapshot,
): { start: number; end: number } | null {
  if (before.type !== after.type || didViewportScrollChange(before, after)) {
    return null;
  }
  const range = readObservedRowRange(term);
  if (!range) return null;
  let { start, end } = range;
  for (const cursorY of [before.cursorY, after.cursorY]) {
    if (cursorY === null) return null;
    start = Math.min(start, cursorY);
    end = Math.max(end, cursorY);
  }
  return { start, end };
}

function executeViewportRefresh(
  term: Terminal,
  synchronous: boolean,
  range?: { start: number; end: number } | null,
): void {
  if (typeof term.rows !== 'number' || term.rows < 1) return;
  try {
    const maxRow = Math.max(0, term.rows - 1);
    const start = range ? Math.min(Math.max(range.start, 0), maxRow) : 0;
    const end = range ? Math.min(Math.max(range.end, start), maxRow) : maxRow;
    const core = (
      term as unknown as {
        _core?: {
          refresh?: (start: number, end: number, sync?: boolean) => void;
        };
      }
    )._core;
    if (synchronous && typeof core?.refresh === 'function') {
      core.refresh(start, end, true);
      return;
    }
    if (typeof term.refresh === 'function') {
      term.refresh(start, end);
      return;
    }
    core?.refresh?.(start, end, false);
  } catch {}
}

const pendingAtlasClears = new WeakSet<Terminal>();

function cancelFollowupViewportRefresh(term: Terminal): void {
  const existing = followupRefreshHandles.get(term);
  if (!existing) return;
  followupRefreshHandles.delete(term);
  if (existing.kind === 'raf' && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(existing.id);
  } else {
    clearTimeout(existing.id);
  }
}

function flushFollowupRefresh(
  term: Terminal,
  shouldRefreshSynchronously?: () => boolean,
): void {
  followupRefreshHandles.delete(term);
  if (pendingAtlasClears.has(term)) {
    pendingAtlasClears.delete(term);
    try {
      term.clearTextureAtlas?.();
    } catch {}
  }
  executeViewportRefresh(term, shouldRefreshSynchronously?.() ?? true);
}

function scheduleFollowupViewportRefresh(
  term: Terminal,
  shouldRefreshSynchronously?: () => boolean,
  clearTextureAtlas = false,
): void {
  if (clearTextureAtlas) {
    pendingAtlasClears.add(term);
  }
  cancelFollowupViewportRefresh(term);
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => {
      flushFollowupRefresh(term, shouldRefreshSynchronously);
    });
    followupRefreshHandles.set(term, { kind: 'raf', id });
    return;
  }
  const id = window.setTimeout(() => {
    flushFollowupRefresh(term, shouldRefreshSynchronously);
  }, 16);
  followupRefreshHandles.set(term, { kind: 'timeout', id });
}

export function disposeTerminalRefreshTracking(term: Terminal): void {
  cancelFollowupViewportRefresh(term);
  pendingAtlasClears.delete(term);
  const tracker = refreshTrackers.get(term);
  if (tracker) {
    try {
      tracker.dispose();
    } catch {}
  }
  refreshTrackers.delete(term);
}

export function writeTerminalOutputWithRefresh(
  term: Terminal,
  data: Uint8Array | string,
  options: {
    forceViewportRefresh?: boolean;
    followupViewportRefresh?: boolean;
    clearTextureAtlasOnFollowup?: boolean;
    shouldRefreshViewportSynchronously?: () => boolean;
    onParsed?: () => void;
  } = {},
): boolean {
  const before = options.forceViewportRefresh ? captureBufferSnapshot(term) : null;
  if (before) {
    resetRefreshRowTracker(term);
  }
  const handleParsed = () => {
    if (before) {
      const after = captureBufferSnapshot(term);
      const sync = options.shouldRefreshViewportSynchronously?.() ?? true;
      const range = resolveRefreshRowRange(term, before, after);
      executeViewportRefresh(term, sync, range);
      if (
        options.followupViewportRefresh ||
        options.clearTextureAtlasOnFollowup ||
        didViewportScrollChange(before, after)
      ) {
        scheduleFollowupViewportRefresh(
          term,
          options.shouldRefreshViewportSynchronously,
          Boolean(options.clearTextureAtlasOnFollowup),
        );
      }
    }
    options.onParsed?.();
  };
  try {
    term.write(data, handleParsed);
    return true;
  } catch {
    options.onParsed?.();
    return false;
  }
}
