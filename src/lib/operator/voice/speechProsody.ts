// Kite Code — Speech Prosody Normalizer & Incremental LLM -> TTS Sentence Pipeline
// Strips technical noise (UUIDs, file paths, raw URLs, SHAs, CLI flags, template clichés)
// before vocalization and extracts complete sentences live from streaming JSON LLM output.

const UUID_RE = /\b(?:thread:|agent:|session:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PAREN_ID_RE = /\(\s*(?:id|uuid|hilo|thread|ruta|path)\s*:\s*[^)]*\)/gi;
const BRACKET_ID_RE = /\[\s*(?:id|uuid)\s*:\s*[^\]]*\]/gi;
const WINDOWS_PATH_RE = /\b[A-Za-z]:\\(?:[^\s,;()'"`]+\\)*([^\s,;()'"`\\]+)/g;
const UNIX_OR_REPO_PATH_RE =
  /(?:^|(?<=[\s(\["']))(?:\/(?:Users|home|var|tmp|opt|etc|mnt)\/[^\s,;()'"`]+|(?:src|src-tauri|odd|docs|scripts|crates|packages|tests)\/(?:[^\s,;()'"`]+\/)*[^\s,;()'"`]+)/g;
const RAW_URL_RE = /https?:\/\/([a-zA-Z0-9.-]+)(?:\/[^\s,;()'"`]*)?/gi;
const CLI_FLAG_RE = /(?:^|(?<=\s))--[a-z][a-z0-9-]*(?:=[^\s,;()'"`]+)?/gi;
const ISOLATED_SHA_RE = /\b(?=[0-9a-f]{7,40}\b)(?=.*\d)(?=.*[a-f])[0-9a-f]{7,40}\b/gi;

const TEMPLATE_CLICHE_PATTERNS: RegExp[] = [
  /\s*Seguimos conversando por ac[aá]\.?\s*/gi,
  /\s*Seguimos por ac[aá]\.?\s*/gi,
  /\s*¿En qu[eé] (?:m[aá]s )?(?:te )?puedo ayudar(?:te)? hoy\??\s*$/gi,
];

export interface ProsodyOptions {
  maxSentences?: number;
  stripClichés?: boolean;
}

function humanizeFileBasename(rawPath: string): string {
  const clean = rawPath.replace(/["'`.,;:!?]+$/, '');
  const parts = clean.split(/[\\/]/).filter(Boolean);
  const last = parts[parts.length - 1] || '';
  if (!last) return 'ese archivo';
  // Drop noisy extension punctuation only for deeply nested specs if very long
  return last.length > 36 ? 'ese archivo' : last;
}

/**
 * Prepares assistant text for spoken TTS prosody:
 * - Removes raw UUIDs, full OS/repo file paths, URLs, git SHAs, CLI flags, and markdown noise.
 * - Strips repetitive template clichés.
 * - Optionally bounds output to N complete sentences without mid-sentence cuts.
 */
export function normalizeForVoiceSpeech(
  text: string,
  options: ProsodyOptions = {}
): string {
  if (!text || !text.trim()) return '';

  let cleaned = text;

  // 1. Replace fenced code blocks before inline path/symbol scrubbing
  cleaned = cleaned.replace(/```[\s\S]*?```/g, ' bloque de código omitido ');

  // 2. Strip inline markdown syntax
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  cleaned = cleaned.replace(/^#+\s+/gm, '');
  cleaned = cleaned.replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1');
  cleaned = cleaned.replace(/^[-*+]\s+/gm, '');
  cleaned = cleaned.replace(/^\d+\.\s+/gm, '');

  // 3. Strip parenthetical IDs/paths and raw UUIDs
  cleaned = cleaned.replace(PAREN_ID_RE, '');
  cleaned = cleaned.replace(BRACKET_ID_RE, '');
  cleaned = cleaned.replace(UUID_RE, '');

  // 4. Humanize raw URLs to domain only
  cleaned = cleaned.replace(RAW_URL_RE, (_m, host: string) => host.replace(/^www\./i, ''));

  // 5. Humanize Windows and repo/POSIX paths (keep readable basename, never recite C:\Users\...)
  cleaned = cleaned.replace(WINDOWS_PATH_RE, (full) => humanizeFileBasename(full));
  cleaned = cleaned.replace(UNIX_OR_REPO_PATH_RE, (full) => humanizeFileBasename(full));

  // 6. Remove CLI flags and isolated hex commit SHAs
  cleaned = cleaned.replace(CLI_FLAG_RE, '');
  cleaned = cleaned.replace(ISOLATED_SHA_RE, '');

  // 7. Remove emojis and technical operators
  cleaned = cleaned.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}«»]/gu, '');
  cleaned = cleaned.replace(/&&|\|\|/g, ' y ');
  cleaned = cleaned.replace(/!=|!==/g, ' distinto de ');
  cleaned = cleaned.replace(/==|===/g, ' igual a ');
  cleaned = cleaned.replace(/->|=>/g, ' hacia ');
  cleaned = cleaned.replace(/:\s+/g, ', ');
  cleaned = cleaned.replace(/\s*—\s*/g, ', ');

  // 8. Strip template clichés when requested (default true)
  if (options.stripClichés !== false) {
    for (const pattern of TEMPLATE_CLICHE_PATTERNS) {
      cleaned = cleaned.replace(pattern, ' ');
    }
  }

  // 9. Clean dangling punctuation and whitespace artifacts left by removals
  cleaned = cleaned
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\s+([.,;!?])/g, '$1')
    .replace(/,\s*\./g, '.')
    .replace(/\.\s*\./g, '.')
    .replace(/\s+/g, ' ')
    .trim();

  // 10. Optional sentence cap preserving complete sentences
  if (options.maxSentences && options.maxSentences > 0 && cleaned) {
    const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
    if (sentences && sentences.length > options.maxSentences) {
      cleaned = sentences
        .slice(0, options.maxSentences)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(' ');
    }
  }

  return cleaned;
}

/**
 * Incrementally extracts complete spoken sentences from a streaming JSON object
 * containing `"answer"` or `"reply"` string fields as LLM SSE tokens arrive.
 *
 * Safety invariant: callers may gate flushing until `"actions": []` is known or
 * stream immediately for `"answer"` fields (which are strictly conversational).
 */
export class StreamingJsonReplyExtractor {
  private rawBuffer = '';
  private activeField: 'answer' | 'reply' | null = null;
  private fieldValueStart = -1;
  private decodedText = '';
  private scanCursor = 0;
  private fieldClosed = false;
  private emittedCursor = 0;
  private readonly targetFields: readonly ('answer' | 'reply')[];

  constructor(targetFields: readonly ('answer' | 'reply')[] = ['answer', 'reply']) {
    this.targetFields = targetFields;
  }

  public getActiveField(): 'answer' | 'reply' | null {
    return this.activeField;
  }

  public getDecodedText(): string {
    return this.decodedText;
  }

  public pushDelta(delta: string): string[] {
    if (!delta) return [];
    this.rawBuffer += delta;

    if (!this.activeField) {
      this.locateTargetField();
    }

    if (this.activeField && !this.fieldClosed) {
      this.decodeAvailableChars();
    }

    return this.drainCompleteSentences(false);
  }

  public finish(): string[] {
    if (!this.activeField) {
      this.locateTargetField();
    }
    if (this.activeField && !this.fieldClosed) {
      this.decodeAvailableChars();
    }
    return this.drainCompleteSentences(true);
  }

  private locateTargetField(): void {
    let bestField: 'answer' | 'reply' | null = null;
    let bestStart = Number.POSITIVE_INFINITY;

    for (const field of this.targetFields) {
      const re = new RegExp(`"${field}"\\s*:\\s*"`, 'g');
      const match = re.exec(this.rawBuffer);
      if (match && match.index !== undefined) {
        const valueStart = match.index + match[0].length;
        if (valueStart < bestStart) {
          bestStart = valueStart;
          bestField = field;
        }
      }
    }

    if (bestField) {
      this.activeField = bestField;
      this.fieldValueStart = bestStart;
      this.scanCursor = bestStart;
    }
  }

  private decodeAvailableChars(): void {
    while (this.scanCursor < this.rawBuffer.length) {
      const ch = this.rawBuffer[this.scanCursor];
      if (ch === '"') {
        this.fieldClosed = true;
        this.scanCursor += 1;
        return;
      }
      if (ch === '\\') {
        if (this.scanCursor + 1 >= this.rawBuffer.length) {
          return; // wait for next delta
        }
        const next = this.rawBuffer[this.scanCursor + 1];
        if (next === 'u') {
          if (this.scanCursor + 6 > this.rawBuffer.length) {
            return; // wait for 4 hex digits
          }
          const hex = this.rawBuffer.slice(this.scanCursor + 2, this.scanCursor + 6);
          const code = Number.parseInt(hex, 16);
          if (!Number.isNaN(code)) {
            this.decodedText += String.fromCharCode(code);
          }
          this.scanCursor += 6;
        } else {
          const map: Record<string, string> = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            n: ' ',
            r: ' ',
            t: ' ',
          };
          this.decodedText += map[next] ?? next;
          this.scanCursor += 2;
        }
      } else {
        this.decodedText += ch;
        this.scanCursor += 1;
      }
    }
  }

  private drainCompleteSentences(flushRemainder: boolean): string[] {
    if (this.fieldValueStart < 0) return [];
    const remaining = this.decodedText.slice(this.emittedCursor);
    if (!remaining) return [];

    const emitted: string[] = [];
    const boundaryRe = /[^.!?]+[.!?]+(?=\s|$)/g;
    let lastEnd = 0;
    let match: RegExpExecArray | null;

    while ((match = boundaryRe.exec(remaining)) !== null) {
      const sentenceEnd = match.index + match[0].length;
      // If field is still streaming and boundary is right at the end of buffer without trailing space,
      // wait one more delta to avoid splitting abbreviations or ellipses unless fieldClosed/flushRemainder.
      if (!flushRemainder && !this.fieldClosed && sentenceEnd >= remaining.length) {
        break;
      }
      const candidate = normalizeForVoiceSpeech(match[0]);
      if (candidate.length >= 2) {
        emitted.push(candidate);
      }
      lastEnd = sentenceEnd;
    }

    this.emittedCursor += lastEnd;

    if (flushRemainder || this.fieldClosed) {
      const tail = normalizeForVoiceSpeech(this.decodedText.slice(this.emittedCursor));
      this.emittedCursor = this.decodedText.length;
      if (tail.length >= 2) {
        emitted.push(tail);
      }
    }

    return emitted;
  }
}

export interface SpeechSentenceQueueCallbacks {
  speakSentence: (sentence: string, index: number) => Promise<void>;
  onFirstSentence?: (sentence: string) => void;
  onComplete?: () => void;
  onError?: (err: unknown) => void;
}

/**
 * Serializes streamed sentences into a TTS engine while allowing instant abort on barge-in.
 */
export class SpeechSentenceQueue {
  private readonly callbacks: SpeechSentenceQueueCallbacks;
  private queue: string[] = [];
  private running = false;
  private closed = false;
  private aborted = false;
  private sentenceCount = 0;
  private doneResolvers: Array<() => void> = [];

  constructor(callbacks: SpeechSentenceQueueCallbacks) {
    this.callbacks = callbacks;
  }

  public enqueue(sentence: string): void {
    if (this.aborted || this.closed) return;
    const clean = normalizeForVoiceSpeech(sentence);
    if (!clean) return;

    if (this.sentenceCount === 0 && this.queue.length === 0) {
      this.callbacks.onFirstSentence?.(clean);
    }
    this.queue.push(clean);
    void this.pump();
  }

  public close(): Promise<void> {
    this.closed = true;
    if (!this.running && this.queue.length === 0) {
      this.notifyDone();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.doneResolvers.push(resolve);
    });
  }

  public abort(): void {
    this.aborted = true;
    this.closed = true;
    this.queue = [];
    this.notifyDone();
  }

  public hasSpokenAny(): boolean {
    return this.sentenceCount > 0;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      while (!this.aborted && this.queue.length > 0) {
        const next = this.queue.shift()!;
        const idx = this.sentenceCount++;
        await this.callbacks.speakSentence(next, idx);
      }
    } catch (err) {
      if (!this.aborted) {
        this.callbacks.onError?.(err);
      }
    } finally {
      this.running = false;
      if (this.aborted || (this.closed && this.queue.length === 0)) {
        this.notifyDone();
      } else if (this.queue.length > 0) {
        void this.pump();
      }
    }
  }

  private notifyDone(): void {
    const resolvers = this.doneResolvers;
    this.doneResolvers = [];
    if (!this.aborted) {
      this.callbacks.onComplete?.();
    }
    for (const r of resolvers) {
      r();
    }
  }
}
