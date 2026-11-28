// Pure deterministic AudioContext span tracking and sentence/paragraph segmentation
// for VoiceTeleprompterDock word karaoke and barge-in freezing.

export interface AudioSpan {
  startAt: number;
  endAt: number;
  talkerDur: number;
}

export interface LiveTeleprompterLine {
  seq: number;
  kind: 'user' | 'voice';
  text: string;
  timeMs: number;
  interim?: boolean;
  spokenChars?: number;
  utteranceStart?: number;
  utteranceEnd?: number;
  talkerDuration?: number;
  audioSpans?: AudioSpan[];
}

export interface TeleprompterParagraph {
  start: number;
  end: number;
  kind: 'lead' | 'body';
  text: string;
}

export interface TeleprompterTurnView {
  speakingUserLine?: LiveTeleprompterLine;
  lastUserLine?: LiveTeleprompterLine;
  agentLines: LiveTeleprompterLine[];
}

const SPAN_COALESCE_GAP_SEC = 0.02;
const RATE_MATCH_TOLERANCE = 0.02;
const SENTENCE_BOUNDARY_RE = /[.!?…]+(?:["'”’)\]]*)(?=\s|$)|\n{2,}/g;

/**
 * Appends a scheduled AudioContext playback span, coalescing contiguous spans
 * separated by <0.02s when playback speed matches the preceding span's rate.
 */
export function appendAudioSpan(
  spans: AudioSpan[] | undefined,
  startAt: number,
  endAt: number,
  playbackSpeed: number,
): AudioSpan[] {
  const next = spans ? [...spans] : [];
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
    return next;
  }

  const safeSpeed = Number.isFinite(playbackSpeed) && playbackSpeed > 0 ? playbackSpeed : 1;
  const wallDur = endAt - startAt;
  const talkerDur = wallDur * safeSpeed;

  if (next.length > 0) {
    const prev = next[next.length - 1];
    const prevWall = prev.endAt - prev.startAt;
    const prevRate = prevWall > 0 ? prev.talkerDur / prevWall : safeSpeed;
    const gap = Math.abs(startAt - prev.endAt);

    if (
      startAt >= prev.startAt &&
      gap < SPAN_COALESCE_GAP_SEC &&
      Math.abs(prevRate - safeSpeed) <= RATE_MATCH_TOLERANCE
    ) {
      if (endAt <= prev.endAt) {
        return next;
      }
      const effectiveStart = Math.max(startAt, prev.endAt);
      const addedTalkerDur = (endAt - effectiveStart) * safeSpeed;
      next[next.length - 1] = {
        startAt: prev.startAt,
        endAt,
        talkerDur: prev.talkerDur + addedTalkerDur,
      };
      return next;
    }
  }

  next.push({ startAt, endAt, talkerDur });
  return next;
}

/**
 * Computes normalized 0..1 utterance progress by interpolating linearly across
 * scheduled AudioContext spans weighted against max(talkerDuration, sumTalkerDur),
 * falling back to utteranceStart..utteranceEnd when no spans exist.
 */
export function computeAudioSpanProgress(
  currentTime: number,
  line: Pick<
    LiveTeleprompterLine,
    'audioSpans' | 'talkerDuration' | 'utteranceStart' | 'utteranceEnd'
  >,
): number {
  if (!Number.isFinite(currentTime)) {
    return 0;
  }

  const spans = line.audioSpans;
  if (spans && spans.length > 0) {
    let sumTalkerDur = 0;
    let playedTalkerDur = 0;

    for (const span of spans) {
      const spanTalker = Number.isFinite(span.talkerDur) ? Math.max(0, span.talkerDur) : 0;
      sumTalkerDur += spanTalker;

      const spanWall = span.endAt - span.startAt;
      if (currentTime >= span.endAt) {
        playedTalkerDur += spanTalker;
      } else if (currentTime > span.startAt && spanWall > 0) {
        const fraction = Math.max(0, Math.min(1, (currentTime - span.startAt) / spanWall));
        playedTalkerDur += spanTalker * fraction;
      }
    }

    const declaredDur =
      typeof line.talkerDuration === 'number' && Number.isFinite(line.talkerDuration)
        ? Math.max(0, line.talkerDuration)
        : 0;
    const totalDur = Math.max(declaredDur, sumTalkerDur);
    if (totalDur <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(1, playedTalkerDur / totalDur));
  }

  if (typeof line.utteranceStart === 'number' && Number.isFinite(line.utteranceStart)) {
    if (
      typeof line.utteranceEnd === 'number' &&
      Number.isFinite(line.utteranceEnd) &&
      line.utteranceEnd > line.utteranceStart
    ) {
      const ratio =
        (currentTime - line.utteranceStart) / (line.utteranceEnd - line.utteranceStart);
      return Math.max(0, Math.min(1, ratio));
    }
    if (
      typeof line.talkerDuration === 'number' &&
      Number.isFinite(line.talkerDuration) &&
      line.talkerDuration > 0
    ) {
      const ratio = (currentTime - line.utteranceStart) / line.talkerDuration;
      return Math.max(0, Math.min(1, ratio));
    }
  }

  return 0;
}

/**
 * Computes the monotonic spoken character boundary for a teleprompter line.
 * When `line.spokenChars` is defined after barge-in, the cursor stays frozen there.
 */
export function computeSpokenCharCount(
  currentTime: number,
  line: LiveTeleprompterLine,
  prevSpokenChars = 0,
): number {
  const len = line.text.length;
  if (len === 0) {
    return 0;
  }

  if (typeof line.spokenChars === 'number' && Number.isFinite(line.spokenChars)) {
    return Math.max(0, Math.min(len, Math.floor(line.spokenChars)));
  }

  const progress = computeAudioSpanProgress(currentTime, line);
  const targetChars = Math.round(progress * len);
  const safePrev = Number.isFinite(prevSpokenChars) ? Math.max(0, Math.floor(prevSpokenChars)) : 0;
  return Math.min(len, Math.max(safePrev, targetChars));
}

function trimSentenceRange(
  text: string,
  rawStart: number,
  rawEnd: number,
): { start: number; end: number } | null {
  let start = rawStart;
  let end = rawEnd;
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  return end > start ? { start, end } : null;
}

/**
 * Splits text by punctuation boundaries; when `withLead` is true, the first sentence
 * becomes `kind: 'lead'` and subsequent sentences group 2 per `kind: 'body'` paragraph.
 */
export function splitTeleprompterParagraphs(
  text: string,
  withLead = true,
): TeleprompterParagraph[] {
  if (!text || !/\S/.test(text)) {
    return [];
  }

  const sentences: Array<{ start: number; end: number }> = [];
  SENTENCE_BOUNDARY_RE.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = SENTENCE_BOUNDARY_RE.exec(text)) !== null) {
    const boundaryEnd = match.index + match[0].length;
    const range = trimSentenceRange(text, cursor, boundaryEnd);
    if (range) {
      sentences.push(range);
    }
    cursor = boundaryEnd;
  }

  if (cursor < text.length) {
    const tail = trimSentenceRange(text, cursor, text.length);
    if (tail) {
      sentences.push(tail);
    }
  }

  if (sentences.length === 0) {
    return [];
  }

  const paragraphs: TeleprompterParagraph[] = [];
  let bodyStartIdx = 0;

  if (withLead) {
    const first = sentences[0];
    paragraphs.push({
      start: first.start,
      end: first.end,
      kind: 'lead',
      text: text.slice(first.start, first.end),
    });
    bodyStartIdx = 1;
  }

  for (let i = bodyStartIdx; i < sentences.length; i += 2) {
    const first = sentences[i];
    const second = sentences[i + 1] ?? first;
    paragraphs.push({
      start: first.start,
      end: second.end,
      kind: 'body',
      text: text.slice(first.start, second.end),
    });
  }

  return paragraphs;
}

function isVisibleVoiceLine(line: LiveTeleprompterLine): boolean {
  if (line.kind !== 'voice') return false;
  if (!/\S/.test(line.text)) return false;
  if (line.spokenChars === undefined) return true;
  if (!Number.isFinite(line.spokenChars) || line.spokenChars <= 0) return false;
  return /\S/.test(line.text.slice(0, line.spokenChars));
}

/**
 * Selects the active turn snapshot: latest user turn (`speakingUserLine` while interim,
 * `lastUserLine` overall) and following assistant lines whose spoken prefix contains text.
 */
export function selectTeleprompterTurnView(lines: LiveTeleprompterLine[]): TeleprompterTurnView {
  if (!lines || lines.length === 0) {
    return { agentLines: [] };
  }

  let lastUserIdx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].kind === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx === -1) {
    return {
      agentLines: lines.filter(isVisibleVoiceLine),
    };
  }

  const lastUserLine = lines[lastUserIdx];
  const speakingUserLine = lastUserLine.interim ? lastUserLine : undefined;
  const agentLines = lines.slice(lastUserIdx + 1).filter(isVisibleVoiceLine);

  return {
    ...(speakingUserLine ? { speakingUserLine } : {}),
    lastUserLine,
    agentLines,
  };
}

export interface TeleprompterToken {
  text: string;
  isWord: boolean;
  start: number;
}

/** Splits paragraph text into word and whitespace tokens preserving character offsets. */
export function tokenizeTeleprompterParagraph(text: string): TeleprompterToken[] {
  const tokens: TeleprompterToken[] = [];
  const re = /(\S+|\s+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const value = match[0];
    tokens.push({
      text: value,
      isWord: /\S/.test(value),
      start: match.index,
    });
  }
  return tokens;
}
