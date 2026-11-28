// Already transcribed speech stays on screen. A new chunk is only the unstable tail.

const PARTIAL_EDGE_PUNCT_RE =
  /^[\s.,;:!?¡¿"'“”‘’()[\]…—–-]+|[\s.,;:!?¡¿"'“”‘’()[\]…—–-]+$/g;

function normalizePartialWord(word: string): string {
  return word.replace(PARTIAL_EDGE_PUNCT_RE, '').toLowerCase();
}

function slicesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function joinSpeechPartial(stable: string, interim: string): string {
  const head = stable.trim();
  const tail = interim.trim();
  if (!head) return tail;
  if (!tail) return head;
  if (tail.startsWith(head)) return tail;
  if (head.endsWith(tail)) return head;

  const headWords = head.split(/\s+/);
  const tailWords = tail.split(/\s+/);
  const headNorm = headWords.map(normalizePartialWord);
  const tailNorm = tailWords.map(normalizePartialWord);

  if (
    headNorm.length > 0 &&
    tailNorm.length >= headNorm.length &&
    headNorm.every((w) => w.length > 0) &&
    slicesEqual(headNorm, tailNorm.slice(0, headNorm.length))
  ) {
    if (tailWords.length === headWords.length) return head;
    return `${head} ${tailWords.slice(headWords.length).join(' ')}`;
  }

  const maxWords = Math.min(headWords.length, tailWords.length);
  for (let size = maxWords; size > 0; size -= 1) {
    const headSlice = headNorm.slice(headWords.length - size);
    const tailSlice = tailNorm.slice(0, size);
    if (headSlice.every((w) => w.length > 0) && slicesEqual(headSlice, tailSlice)) {
      if (tailWords.length === size) return head;
      return `${head} ${tailWords.slice(size).join(' ')}`;
    }
  }

  const max = Math.min(head.length, tail.length);
  for (let size = max; size > 0; size -= 1) {
    if (head.slice(-size) !== tail.slice(0, size)) continue;
    const before = size === head.length ? '' : head[head.length - size - 1];
    const after = size === tail.length ? '' : tail[size];
    const boundary = (ch: string) => ch === '' || /\s/.test(ch);
    if (!boundary(before) || !boundary(after)) continue;
    return `${head}${tail.slice(size)}`.replace(/\s+/g, ' ').trim();
  }
  return `${head} ${tail}`;
}

export interface LiveTranscriptStabilizerOptions {
  /** Number of trailing words kept mutable while earlier prefix words lock monotonically. */
  mutableTailWords?: number;
  /** Number of consecutive consistent updates before promoting words beyond the trailing tail. */
  agreementCount?: number;
}

/**
 * Stabilizes live streaming STT hypotheses so already-shown earlier words lock
 * monotonically instead of being rewritten backwards when remote STT revises
 * punctuation, filler words, or wording several words back.
 */
export class LiveTranscriptStabilizer {
  private readonly mutableTailWords: number;
  private readonly agreementCount: number;
  private lockedWords: string[] = [];
  private prevTailWords: string[] = [];
  private displayed = '';

  constructor(options: LiveTranscriptStabilizerOptions = {}) {
    this.mutableTailWords = Math.max(1, options.mutableTailWords ?? 3);
    this.agreementCount = Math.max(1, options.agreementCount ?? 2);
  }

  public getDisplayed(): string {
    return this.displayed;
  }

  public pushPartial(rawText: string): string {
    const clean = (rawText || '').trim();
    if (!clean) return this.displayed;

    const incomingWords = clean.split(/\s+/);
    const candidateTail = this.alignIncomingAfterLocked(incomingWords);
    if (candidateTail.length === 0) {
      return this.displayed;
    }

    let agreedLen = 0;
    if (this.agreementCount <= 1) {
      agreedLen = candidateTail.length;
    } else {
      const limit = Math.min(this.prevTailWords.length, candidateTail.length);
      while (
        agreedLen < limit &&
        normalizePartialWord(this.prevTailWords[agreedLen]) ===
          normalizePartialWord(candidateTail[agreedLen])
      ) {
        agreedLen += 1;
      }
    }

    const promoteCount = Math.max(
      0,
      Math.min(agreedLen, candidateTail.length - this.mutableTailWords)
    );
    if (promoteCount > 0) {
      const sourceForLock =
        this.agreementCount <= 1 ? candidateTail : this.prevTailWords;
      this.lockedWords.push(...sourceForLock.slice(0, promoteCount));
    }

    const mutableTail = candidateTail.slice(promoteCount);
    this.prevTailWords = mutableTail;
    this.displayed = [...this.lockedWords, ...mutableTail].join(' ');
    return this.displayed;
  }

  public pushFinal(rawText: string): string {
    const clean = (rawText || '').trim();
    if (!clean) return this.displayed;

    const incomingWords = clean.split(/\s+/);
    const candidateTail = this.alignIncomingAfterLocked(incomingWords);
    if (candidateTail.length > 0) {
      this.lockedWords.push(...candidateTail);
    }
    this.prevTailWords = [];
    this.displayed = this.lockedWords.join(' ');
    return this.displayed;
  }

  public reset(): void {
    this.lockedWords = [];
    this.prevTailWords = [];
    this.displayed = '';
  }

  private alignIncomingAfterLocked(incomingWords: string[]): string[] {
    if (this.lockedWords.length === 0) {
      return incomingWords;
    }

    const lockedNorm = this.lockedWords.map(normalizePartialWord);
    const incomingNorm = incomingWords.map(normalizePartialWord);

    // Prevent transient shorter sub-prefix hypotheses from duplicating locked openings.
    const isSubPrefixOfLocked =
      incomingNorm.length < lockedNorm.length &&
      incomingNorm.every((word, idx) => word === lockedNorm[idx]);
    if (isSubPrefixOfLocked) {
      return [];
    }

    // Case A: cumulative prefix match (allow >= 80% alignment for minor punctuation/word shifts).
    if (incomingNorm.length >= lockedNorm.length) {
      let matches = 0;
      for (let i = 0; i < lockedNorm.length; i += 1) {
        if (lockedNorm[i] === incomingNorm[i]) {
          matches += 1;
        }
      }
      if (matches / lockedNorm.length >= 0.8) {
        return incomingWords.slice(this.lockedWords.length);
      }
    }

    // Case B: anchor on the last 2–3 locked words inside a bounded window around the boundary
    // so inserted/deleted filler words deep inside the locked prefix never duplicate at the seam.
    const minAnchor = lockedNorm.length === 1 ? 1 : 2;
    const maxAnchor = Math.min(3, lockedNorm.length);
    for (let anchorLen = maxAnchor; anchorLen >= minAnchor; anchorLen -= 1) {
      const anchor = lockedNorm.slice(lockedNorm.length - anchorLen);
      if (anchor.some((w) => w.length === 0)) continue;
      const expectedStart = lockedNorm.length - anchorLen;
      const minStart = Math.max(0, expectedStart - 5);
      const maxStart = Math.min(incomingNorm.length - anchorLen, expectedStart + 5);
      for (let start = minStart; start <= maxStart; start += 1) {
        if (slicesEqual(incomingNorm.slice(start, start + anchorLen), anchor)) {
          return incomingWords.slice(start + anchorLen);
        }
      }
    }

    // Case C: non-cumulative incremental clause overlapping the end of lockedWords.
    if (incomingNorm[0] !== lockedNorm[0]) {
      const maxOverlap = Math.min(4, lockedNorm.length, incomingNorm.length);
      for (let size = maxOverlap; size >= 1; size -= 1) {
        const lockedEnd = lockedNorm.slice(lockedNorm.length - size);
        const incomingStart = incomingNorm.slice(0, size);
        if (lockedEnd.every((w) => w.length > 0) && slicesEqual(lockedEnd, incomingStart)) {
          return incomingWords.slice(size);
        }
      }
    }

    // Case D: fallback never shrinks backwards; append strictly beyond locked length.
    if (incomingWords.length > this.lockedWords.length) {
      return incomingWords.slice(this.lockedWords.length);
    }
    return [];
  }
}

const SPANISH_OPEN_CLAUSE_RE =
  /(?:[,:;…]+|\.{2,}|(?<![a-záéíóúñ])(?:eh+|em+|este|mmm+|para|con|que|de|del|en|por|como|o|u|y|e|ni|si|porque|cuando|donde|aunque|sin|a|al|pero|sino|mientras|luego|despu[eé]s|adem[aá]s|entonces|o\s+sea|es\s+decir|bueno|pues|digamos|quiero|necesito|abre|abrir|cierra|cerrar|lanza|lanzar|delega|delegar|dile|p[aá]sale))(?![a-záéíóúñ])\s*$/i;

/**
 * Returns true when a partial Spanish utterance ends in an open connector,
 * hesitation, preposition, conjunction, or trailing continuation punctuation
 * (comma, ellipsis) indicating the speaker has not finished their thought.
 */
export function isSpanishOpenClause(text: string): boolean {
  const clean = (text || '').trim();
  if (!clean) return false;
  return SPANISH_OPEN_CLAUSE_RE.test(clean);
}

export interface SpeculativePreCaptureOptions<T> {
  stabilityMs?: number;
  ttlMs?: number;
  minChars?: number;
  onStable: (partial: string) => Promise<T | null> | T | null;
}

/**
 * Speculatively pre-captures turn context and warms caches once a partial STT
 * transcript stays unchanged for >250ms, cancelling cleanly if speech continues.
 */
export class SpeculativePartialPreCapture<T = unknown> {
  private readonly stabilityMs: number;
  private readonly ttlMs: number;
  private readonly minChars: number;
  private readonly onStable: (partial: string) => Promise<T | null> | T | null;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastPartial = '';
  private epoch = 0;
  private cached: { partial: string; value: T; capturedAt: number } | null = null;

  constructor(options: SpeculativePreCaptureOptions<T>) {
    this.stabilityMs = options.stabilityMs ?? 250;
    this.ttlMs = options.ttlMs ?? 4000;
    this.minChars = options.minChars ?? 4;
    this.onStable = options.onStable;
  }

  public update(partial: string): void {
    const clean = (partial || '').trim();
    if (clean === this.lastPartial) return;
    this.lastPartial = clean;
    this.epoch += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.cached = null;
    if (clean.length < this.minChars) return;

    const myEpoch = this.epoch;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (myEpoch !== this.epoch) return;
      void Promise.resolve(this.onStable(clean))
        .then((value) => {
          if (myEpoch !== this.epoch || value === null || value === undefined) return;
          this.cached = {
            partial: clean,
            value,
            capturedAt: Date.now(),
          };
        })
        .catch(() => {
          // Ignore speculative pre-capture errors; regular capture path runs on turn submit.
        });
    }, this.stabilityMs);
  }

  public consume(finalText: string, nowMs: number = Date.now()): T | null {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.epoch += 1;
    const snap = this.cached;
    this.cached = null;
    this.lastPartial = '';
    if (!snap) return null;
    if (nowMs - snap.capturedAt > this.ttlMs) return null;

    const normFinal = (finalText || '').trim().toLowerCase();
    const normPartial = snap.partial.toLowerCase();
    if (!normFinal) return null;
    if (
      normFinal === normPartial ||
      normFinal.startsWith(normPartial) ||
      normPartial.startsWith(normFinal)
    ) {
      return snap.value;
    }
    return null;
  }

  public reset(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.epoch += 1;
    this.lastPartial = '';
    this.cached = null;
  }
}
