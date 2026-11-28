// Kite Code — Hybrid Tap-vs-Hold PTT Controller & In-Call Text Sync Batcher (Argos)
// Supports <500ms tap-to-toggle vs >=500ms hold-to-talk Spacebar control with blur safety,
// and 250ms coalescing of rapid in-call typed text messages and attachment references.

export const TAP_HOLD_THRESHOLD_MS = 500;
export const DEFAULT_TEXT_SYNC_BATCH_MS = 250;

export type PttMode = 'idle' | 'hold-to-talk' | 'tap-to-toggle';
export type PttStopReason = 'hold-release' | 'tap-toggle-off' | 'blur' | 'manual';

export interface EditableTargetLike {
  tagName?: string;
  type?: string;
  value?: string;
  isContentEditable?: boolean;
  textContent?: string | null;
}

export interface PttKeyDownMeta {
  repeat?: boolean;
  target?: EditableTargetLike | null;
  isEditableWithText?: boolean;
}

export interface HybridPttOptions {
  thresholdMs?: number;
  isCapturing?: () => boolean;
  onStartCapture?: (mode: Exclude<PttMode, 'idle'>) => void;
  onStopCapture?: (reason: PttStopReason) => void;
  onModeChange?: (mode: PttMode) => void;
  isEditableTarget?: (meta?: PttKeyDownMeta) => boolean;
}

export interface HybridPttState {
  mode: PttMode;
  isCapturing: boolean;
  isKeyPressed: boolean;
  keyDownAtMs: number | null;
}

export interface PttKeyUpOutcome {
  action: 'none' | 'stopped-hold' | 'toggled-on' | 'toggled-off';
  mode: PttMode;
  isCapturing: boolean;
  heldMs: number;
}

const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'file',
  'image',
  'range',
  'color',
  'hidden',
]);

/**
 * Returns true when focus is inside an editable input/textarea/contentEditable
 * that currently contains non-empty text, so Spacebar edits text instead of triggering PTT.
 */
export function isEditableTargetWithText(target?: EditableTargetLike | null): boolean {
  const el =
    target !== undefined
      ? target
      : typeof document !== 'undefined'
        ? (document.activeElement as EditableTargetLike | null)
        : null;
  if (!el) return false;

  const tag = (el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') {
    return (el.value || '').trim().length > 0;
  }
  if (tag === 'INPUT') {
    const inputType = (el.type || 'text').toLowerCase();
    if (NON_TEXT_INPUT_TYPES.has(inputType)) return false;
    return (el.value || '').trim().length > 0;
  }
  if (el.isContentEditable) {
    return (el.textContent || '').trim().length > 0;
  }
  return false;
}

/**
 * Hybrid Push-To-Talk state machine:
 * - Held >= 500 ms -> hold-to-talk (commits/stops immediately on keyup or blur).
 * - Tapped < 500 ms -> tap-to-toggle (starts capture if idle; toggles off if already in toggle mode).
 */
export class HybridPttController {
  private readonly thresholdMs: number;
  private readonly options: HybridPttOptions;

  private mode: PttMode = 'idle';
  private capturing = false;
  private isKeyPressed = false;
  private keyDownAtMs: number | null = null;
  private wasCapturingOnKeyDown = false;

  constructor(options: HybridPttOptions = {}) {
    this.options = options;
    this.thresholdMs =
      typeof options.thresholdMs === 'number' && options.thresholdMs > 0
        ? options.thresholdMs
        : TAP_HOLD_THRESHOLD_MS;
  }

  private getEffectiveCapturing(): boolean {
    if (this.options.isCapturing) {
      return this.options.isCapturing();
    }
    return this.capturing;
  }

  private setMode(next: PttMode): void {
    if (this.mode === next) return;
    this.mode = next;
    this.options.onModeChange?.(next);
  }

  public getState(): HybridPttState {
    return {
      mode: this.mode,
      isCapturing: this.getEffectiveCapturing(),
      isKeyPressed: this.isKeyPressed,
      keyDownAtMs: this.keyDownAtMs,
    };
  }

  public syncExternalCaptureState(capturing: boolean): void {
    this.capturing = capturing;
    if (!capturing) {
      this.isKeyPressed = false;
      this.keyDownAtMs = null;
      this.wasCapturingOnKeyDown = false;
      this.setMode('idle');
    } else if (this.mode === 'idle') {
      this.setMode('tap-to-toggle');
    }
  }

  public handleKeyDown(nowMs: number = Date.now(), meta?: PttKeyDownMeta): boolean {
    if (meta?.repeat) return false;
    if (this.isKeyPressed) return false;

    const editableWithText =
      meta?.isEditableWithText ??
      (this.options.isEditableTarget
        ? this.options.isEditableTarget(meta)
        : isEditableTargetWithText(meta?.target));
    if (editableWithText) return false;

    const currentlyCapturing = this.getEffectiveCapturing();
    this.wasCapturingOnKeyDown = currentlyCapturing;
    this.isKeyPressed = true;
    this.keyDownAtMs = nowMs;

    if (!currentlyCapturing) {
      this.capturing = true;
      this.setMode('hold-to-talk');
      this.options.onStartCapture?.('hold-to-talk');
    }

    return true;
  }

  public handleKeyUp(nowMs: number = Date.now()): PttKeyUpOutcome {
    if (!this.isKeyPressed || this.keyDownAtMs === null) {
      return {
        action: 'none',
        mode: this.mode,
        isCapturing: this.getEffectiveCapturing(),
        heldMs: 0,
      };
    }

    const heldMs = Math.max(0, nowMs - this.keyDownAtMs);
    const wasCapturing = this.wasCapturingOnKeyDown;
    this.isKeyPressed = false;
    this.keyDownAtMs = null;
    this.wasCapturingOnKeyDown = false;

    if (heldMs >= this.thresholdMs) {
      this.capturing = false;
      this.setMode('idle');
      this.options.onStopCapture?.('hold-release');
      return {
        action: 'stopped-hold',
        mode: 'idle',
        isCapturing: false,
        heldMs,
      };
    }

    if (!wasCapturing) {
      this.capturing = true;
      this.setMode('tap-to-toggle');
      return {
        action: 'toggled-on',
        mode: 'tap-to-toggle',
        isCapturing: true,
        heldMs,
      };
    }

    this.capturing = false;
    this.setMode('idle');
    this.options.onStopCapture?.('tap-toggle-off');
    return {
      action: 'toggled-off',
      mode: 'idle',
      isCapturing: false,
      heldMs,
    };
  }

  /**
   * Window/element blur guard: stops capture when holding the PTT key so a missed keyup
   * never leaves the microphone stuck open. Active tap-to-toggle capture stays open unless
   * a key press is currently held down.
   */
  public handleBlur(): boolean {
    const inHoldState = this.mode === 'hold-to-talk' && (this.isKeyPressed || this.getEffectiveCapturing());
    const pressedWhileIdleStart = this.isKeyPressed && !this.wasCapturingOnKeyDown;

    this.isKeyPressed = false;
    this.keyDownAtMs = null;
    this.wasCapturingOnKeyDown = false;

    if (inHoldState || pressedWhileIdleStart) {
      this.capturing = false;
      this.setMode('idle');
      this.options.onStopCapture?.('blur');
      return true;
    }

    return false;
  }

  public dispose(): void {
    this.isKeyPressed = false;
    this.keyDownAtMs = null;
    this.wasCapturingOnKeyDown = false;
    if (this.capturing) {
      this.capturing = false;
      this.setMode('idle');
      this.options.onStopCapture?.('manual');
    } else {
      this.setMode('idle');
    }
  }
}

export interface InCallTextAttachment {
  id?: string;
  name?: string;
  path?: string;
  kind?: string;
  [key: string]: unknown;
}

export interface CoalescedTextTurnPayload {
  text: string;
  messages: string[];
  attachments: InCallTextAttachment[];
  count: number;
  firstEnqueuedAt: number;
  flushedAt: number;
}

export interface InCallTextSyncBatcherOptions {
  batchWindowMs?: number;
  onFlush?: (payload: CoalescedTextTurnPayload) => void | Promise<void>;
}

/**
 * Coalesces rapid typed text messages and attachment references submitted during an active
 * voice call within a 250 ms window into a single merged turn payload.
 */
export class InCallTextSyncBatcher {
  private readonly batchWindowMs: number;
  private readonly onFlush?: (payload: CoalescedTextTurnPayload) => void | Promise<void>;

  private messages: string[] = [];
  private attachments: InCallTextAttachment[] = [];
  private attachmentKeys = new Set<string>();
  private submissionCount = 0;
  private firstEnqueuedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: InCallTextSyncBatcherOptions = {}) {
    this.batchWindowMs =
      typeof options.batchWindowMs === 'number' && options.batchWindowMs >= 0
        ? options.batchWindowMs
        : DEFAULT_TEXT_SYNC_BATCH_MS;
    this.onFlush = options.onFlush;
  }

  public hasPending(): boolean {
    return this.submissionCount > 0;
  }

  public getPendingCount(): number {
    return this.submissionCount;
  }

  public enqueue(
    text: string,
    attachments: InCallTextAttachment[] = [],
    nowMs: number = Date.now()
  ): boolean {
    if (this.disposed) return false;

    const trimmed = (text || '').trim();
    const validAttachments = Array.isArray(attachments)
      ? attachments.filter((a) => a && typeof a === 'object')
      : [];

    if (!trimmed && validAttachments.length === 0) {
      return false;
    }

    if (this.firstEnqueuedAt === null) {
      this.firstEnqueuedAt = nowMs;
    }
    this.submissionCount += 1;

    if (trimmed) {
      this.messages.push(trimmed);
    }

    for (const attachment of validAttachments) {
      const dedupeKey = attachment.id
        ? `id:${attachment.id}`
        : attachment.path
          ? `path:${attachment.path}`
          : null;
      if (dedupeKey) {
        if (this.attachmentKeys.has(dedupeKey)) continue;
        this.attachmentKeys.add(dedupeKey);
      }
      this.attachments.push(attachment);
    }

    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.batchWindowMs);

    return true;
  }

  public flush(nowMs: number = Date.now()): CoalescedTextTurnPayload | null {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.submissionCount === 0) {
      return null;
    }

    const payload: CoalescedTextTurnPayload = {
      text: this.messages.join('\n'),
      messages: [...this.messages],
      attachments: [...this.attachments],
      count: this.submissionCount,
      firstEnqueuedAt: this.firstEnqueuedAt ?? nowMs,
      flushedAt: nowMs,
    };

    this.messages = [];
    this.attachments = [];
    this.attachmentKeys.clear();
    this.submissionCount = 0;
    this.firstEnqueuedAt = null;

    this.onFlush?.(payload);
    return payload;
  }

  public dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.messages = [];
    this.attachments = [];
    this.attachmentKeys.clear();
    this.submissionCount = 0;
    this.firstEnqueuedAt = null;
  }
}
