// Kite Code — Voice Turn Arbitrator
// Guarantees single-floor ownership during voice calls so user speech, SETH replies,
// and proactive agent announcements never overlap.

export type VoiceFloorState =
  | 'idle'
  | 'listening'
  | 'user_speaking'
  | 'endpointing'
  | 'thinking'
  | 'executing'
  | 'speaking'
  | 'barge_in';

export interface QueuedProactiveNotice {
  id: string;
  text: string;
  createdAt: number;
  dispatch: (text: string) => void | Promise<void>;
}

const MAX_QUEUED_NOTICES = 3;
const NOTICE_TTL_MS = 30_000;

export class VoiceTurnArbitrator {
  private state: VoiceFloorState = 'idle';
  private queue: QueuedProactiveNotice[] = [];
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

    if (next === 'idle' || next === 'listening') {
      this.flushOneQueuedNotice();
    }
  }

  public isBusyForProactiveSpeech(): boolean {
    return (
      this.state === 'user_speaking' ||
      this.state === 'endpointing' ||
      this.state === 'thinking' ||
      this.state === 'executing' ||
      this.state === 'speaking' ||
      this.state === 'barge_in'
    );
  }

  /**
   * Speaks a proactive notice immediately when the floor is free, or queues it cleanly
   * until the active user/assistant turn finishes so audio never overlaps.
   */
  public requestProactiveSpeech(
    text: string,
    dispatch: (text: string) => void | Promise<void>,
    nowMs: number = Date.now()
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

    // Drop stale notices and deduplicate identical text
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

  public getQueuedNoticeCount(): number {
    return this.queue.length;
  }

  public clearQueue(): void {
    this.queue = [];
  }

  public flushOneQueuedNotice(nowMs: number = Date.now()): boolean {
    if (this.isBusyForProactiveSpeech()) return false;
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
  }
}

export const voiceTurnArbitrator = new VoiceTurnArbitrator();
