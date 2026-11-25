// Already transcribed speech stays on screen. A new chunk is only the unstable tail.

export function joinSpeechPartial(stable: string, interim: string): string {
  const head = stable.trim();
  const tail = interim.trim();
  if (!head) return tail;
  if (!tail) return head;
  if (tail.startsWith(head)) return tail;
  if (head.endsWith(tail)) return head;

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
