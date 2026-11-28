// Kite Code — Voice Turn Arbitrator (Argos)
// Guarantees single-floor ownership during voice calls so user speech, Argos replies,
// and proactive agent announcements never overlap, folding concurrent subagent returns.

export type VoiceFloorState =
  | 'idle'
  | 'free'
  | 'busy'
  | 'listening'
  | 'user_speaking'
  | 'endpointing'
  | 'thinking'
  | 'executing'
  | 'speaking'
  | 'post_tts_guard'
  | 'awaiting_reply'
  | 'barge_in';

export interface QueuedProactiveNotice {
  id: string;
  text: string;
  createdAt: number;
  dispatch: (text: string) => void | Promise<void>;
}

export interface FoldedProactiveUpdate {
  id: string;
  role?: string;
  summary: string;
  text: string;
  createdAt: number;
  dispatch: (text: string) => void | Promise<void>;
}

export interface ProactiveSpeechMeta {
  role?: string;
  summary?: string;
  foldable?: boolean;
}

const MAX_QUEUED_NOTICES = 3;
const MAX_FOLDED_UPDATES = 8;
const NOTICE_TTL_MS = 30_000;

export class VoiceTurnArbitrator {
  private state: VoiceFloorState = 'idle';
  private queue: QueuedProactiveNotice[] = [];
  private foldedUpdates: FoldedProactiveUpdate[] = [];
  private listeners = new Set<(state: VoiceFloorState) => void>();

  public getState(): VoiceFloorState {
    return this.state;
  }

  public subscribe(listener: (state: VoiceFloorState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public transition(next: VoiceFloorState): void {
    if (this.state === next) return;
    this.state = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {}
    }

    if (
      next === 'idle' ||
      next === 'listening' ||
      next === 'free' ||
      next === 'awaiting_reply'
    ) {
      this.flushOneQueuedNotice();
    }
  }

  public isBusyForProactiveSpeech(): boolean {
    return (
      this.state === 'busy' ||
      this.state === 'user_speaking' ||
      this.state === 'endpointing' ||
      this.state === 'thinking' ||
      this.state === 'executing' ||
      this.state === 'speaking' ||
      this.state === 'post_tts_guard' ||
      this.state === 'barge_in'
    );
  }

  /**
   * Speaks a proactive notice immediately when the floor is free, or buffers/folds it cleanly
   * until the active user/assistant turn finishes so audio never overlaps.
   */
  public requestProactiveSpeech(
    text: string,
    dispatch: (text: string) => void | Promise<void>,
    nowMs: number = Date.now(),
    meta?: ProactiveSpeechMeta
  ): 'dispatched' | 'queued' {
    const clean = text.trim();
    if (!clean) return 'dispatched';

    if (!this.isBusyForProactiveSpeech()) {
      try {
        const res = dispatch(clean);
        if (res instanceof Promise) {
          void res.catch(() => {});
        }
      } catch {}
      return 'dispatched';
    }

    const foldable = meta?.foldable !== false;
    if (!foldable) {
      this.queue = this.queue.filter(
        (item) => nowMs - item.createdAt < NOTICE_TTL_MS && item.text !== clean
      );
      if (this.queue.length >= MAX_QUEUED_NOTICES) {
        this.queue.shift();
      }
      this.queue.push({
        id: `notice-${nowMs}-${Math.random().toString(36).slice(2, 6)}`,
        text: clean,
        createdAt: nowMs,
        dispatch,
      });
      return 'queued';
    }

    // Buffer into `foldedUpdates`, expiring stale entries and deduplicating identical text
    this.foldedUpdates = this.foldedUpdates.filter(
      (item) => nowMs - item.createdAt < NOTICE_TTL_MS && item.text !== clean
    );
    if (this.foldedUpdates.length >= MAX_FOLDED_UPDATES) {
      this.foldedUpdates.shift();
    }
    this.foldedUpdates.push({
      id: `folded-${nowMs}-${Math.random().toString(36).slice(2, 6)}`,
      role: meta?.role,
      summary: (meta?.summary || clean).trim(),
      text: clean,
      createdAt: nowMs,
      dispatch,
    });
    return 'queued';
  }

  public getQueuedNoticeCount(): number {
    return this.queue.length + this.foldedUpdates.length;
  }

  public getFoldedUpdateCount(): number {
    return this.foldedUpdates.length;
  }

  public getFoldedUpdates(): readonly FoldedProactiveUpdate[] {
    return [...this.foldedUpdates];
  }

  public composeFoldedSummary(updates: readonly FoldedProactiveUpdate[]): string {
    if (updates.length === 0) return '';
    if (updates.length === 1) return updates[0].text;
    const parts = updates.map((u) => {
      const body = (u.summary || u.text).trim();
      return u.role ? `${u.role}: ${body}` : body;
    });
    return `Terminaron ${updates.length} tareas en segundo plano. ${parts.join(' ')}`;
  }

  public clearQueue(): void {
    this.queue = [];
    this.foldedUpdates = [];
  }

  public flushOneQueuedNotice(nowMs: number = Date.now()): boolean {
    if (this.isBusyForProactiveSpeech()) return false;

    if (this.foldedUpdates.length > 0) {
      const valid = this.foldedUpdates.filter((item) => nowMs - item.createdAt <= NOTICE_TTL_MS);
      this.foldedUpdates = [];
      if (valid.length > 0) {
        const combined = this.composeFoldedSummary(valid);
        const dispatch = valid[valid.length - 1].dispatch;
        try {
          const res = dispatch(combined);
          if (res instanceof Promise) {
            void res.catch(() => {});
          }
        } catch {}
        return true;
      }
    }

    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (nowMs - next.createdAt > NOTICE_TTL_MS) {
        continue;
      }
      try {
        const res = next.dispatch(next.text);
        if (res instanceof Promise) {
          void res.catch(() => {});
        }
      } catch {}
      return true;
    }
    return false;
  }

  public resetForTests(): void {
    this.state = 'idle';
    this.queue = [];
    this.foldedUpdates = [];
  }
}

export const voiceTurnArbitrator = new VoiceTurnArbitrator();
