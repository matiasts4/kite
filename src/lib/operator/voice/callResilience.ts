// Argos Call Resilience Suite — Device Hot-Swap Recovery, Mic Flatline Detection,
// Screen Wake Lock Management, Playback Speed Controls, and Subagent-Guarded Inactivity Timer.

import { subscribeAudioDeviceChanges } from './audioDevices';

export const DEFAULT_FLATLINE_THRESHOLD_MS = 4500;
export const DEFAULT_FLATLINE_RMS_CEILING = 0.0001;
export const DEFAULT_FLATLINE_RECOVERY_RMS = 0.001;

export interface MicFlatlineDetectorOptions {
  flatlineThresholdMs?: number;
  flatlineRmsCeiling?: number;
  recoveryRmsThreshold?: number;
  now?: () => number;
  onFlatline?: () => void;
  onRecovered?: () => void;
}

export interface MicFlatlineFrameContext {
  isMuted?: boolean;
  isListening?: boolean;
  timestampMs?: number;
}

/**
 * Monitors incoming microphone RMS frames while unmuted and listening.
 * Flags a hardware flatline if RMS remains <= 0.0001 continuously for 4500 ms (default),
 * and clears automatically when signal rises > 0.001 or reset() is called.
 */
export class MicFlatlineDetector {
  private readonly flatlineThresholdMs: number;
  private readonly flatlineRmsCeiling: number;
  private readonly recoveryRmsThreshold: number;
  private readonly now: () => number;
  private readonly onFlatline?: () => void;
  private readonly onRecovered?: () => void;

  private _isFlatlined = false;
  private flatlineSinceMs: number | null = null;
  private isMuted = false;
  private isListening = true;

  constructor(options: MicFlatlineDetectorOptions = {}) {
    this.flatlineThresholdMs = options.flatlineThresholdMs ?? DEFAULT_FLATLINE_THRESHOLD_MS;
    this.flatlineRmsCeiling = options.flatlineRmsCeiling ?? DEFAULT_FLATLINE_RMS_CEILING;
    this.recoveryRmsThreshold = options.recoveryRmsThreshold ?? DEFAULT_FLATLINE_RECOVERY_RMS;
    this.now = options.now ?? (() => Date.now());
    this.onFlatline = options.onFlatline;
    this.onRecovered = options.onRecovered;
  }

  get isFlatlined(): boolean {
    return this._isFlatlined;
  }

  setCaptureState(state: { isMuted?: boolean; isListening?: boolean }): void {
    if (typeof state.isMuted === 'boolean') {
      this.isMuted = state.isMuted;
    }
    if (typeof state.isListening === 'boolean') {
      this.isListening = state.isListening;
    }
    if (this.isMuted || !this.isListening) {
      this.flatlineSinceMs = null;
    }
  }

  pushRms(rms: number, context?: MicFlatlineFrameContext): boolean {
    const muted = context?.isMuted ?? this.isMuted;
    const listening = context?.isListening ?? this.isListening;

    if (muted || !listening) {
      this.flatlineSinceMs = null;
      return this._isFlatlined;
    }

    const safeRms = Number.isFinite(rms) ? Math.max(0, rms) : 0;
    const timestampMs = context?.timestampMs ?? this.now();

    if (safeRms > this.recoveryRmsThreshold) {
      this.flatlineSinceMs = null;
      if (this._isFlatlined) {
        this._isFlatlined = false;
        this.onRecovered?.();
      }
      return this._isFlatlined;
    }

    if (safeRms <= this.flatlineRmsCeiling) {
      if (this.flatlineSinceMs === null) {
        this.flatlineSinceMs = timestampMs;
      } else if (!this._isFlatlined && timestampMs - this.flatlineSinceMs >= this.flatlineThresholdMs) {
        this._isFlatlined = true;
        this.onFlatline?.();
      }
      return this._isFlatlined;
    }

    // Signal rose above dead-zero ceiling, breaking the continuous flatline streak.
    this.flatlineSinceMs = null;
    return this._isFlatlined;
  }

  reset(): void {
    this.flatlineSinceMs = null;
    this._isFlatlined = false;
  }
}

interface WakeLockSentinelLike {
  released?: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

/**
 * Keeps the screen awake during an active voice call using the Screen Wake Lock API,
 * re-acquiring automatically when the page returns to 'visible', and releasing cleanly on stop.
 */
export class ScreenWakeLockManager {
  private sentinel: WakeLockSentinelLike | null = null;
  private wantLock = false;
  private visibilityListenerAttached = false;

  private readonly handleSentinelRelease = (): void => {
    this.sentinel = null;
  };

  private readonly handleVisibilityChange = (): void => {
    if (!this.wantLock) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      void this.requestLock();
    }
  };

  isActive(): boolean {
    return Boolean(this.sentinel && !this.sentinel.released);
  }

  async acquire(): Promise<boolean> {
    this.wantLock = true;
    this.attachVisibilityListener();
    return this.requestLock();
  }

  async release(): Promise<void> {
    this.wantLock = false;
    this.detachVisibilityListener();

    const activeSentinel = this.sentinel;
    this.sentinel = null;
    if (!activeSentinel) return;

    try {
      activeSentinel.removeEventListener?.('release', this.handleSentinelRelease);
    } catch {
      // ignore
    }
    try {
      await activeSentinel.release();
    } catch {
      // ignore release failures on already-released sentinels
    }
  }

  private async requestLock(): Promise<boolean> {
    if (!this.wantLock) return false;
    if (this.sentinel && !this.sentinel.released) return true;

    const wakeLock =
      typeof navigator !== 'undefined'
        ? (navigator as Navigator & {
            wakeLock?: { request?: (type: 'screen') => Promise<WakeLockSentinelLike> };
          }).wakeLock
        : undefined;

    if (!wakeLock || typeof wakeLock.request !== 'function') {
      return false;
    }

    try {
      const acquired = await wakeLock.request('screen');
      if (!this.wantLock) {
        try {
          await acquired.release();
        } catch {
          // ignore
        }
        return false;
      }
      this.sentinel = acquired;
      try {
        acquired.addEventListener?.('release', this.handleSentinelRelease);
      } catch {
        // ignore
      }
      return true;
    } catch {
      return false;
    }
  }

  private attachVisibilityListener(): void {
    if (this.visibilityListenerAttached) return;
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.visibilityListenerAttached = true;
  }

  private detachVisibilityListener(): void {
    if (!this.visibilityListenerAttached) return;
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
    this.visibilityListenerAttached = false;
  }
}

export const INACTIVITY_MIN_TIMEOUT_MS = 15_000;
export const INACTIVITY_MAX_TIMEOUT_MS = 60_000;
export const INACTIVITY_RAMP_DURATION_MS = 300_000;

/**
 * Computes an adaptive inactivity timeout scaling linearly from 15,000 ms to 60,000 ms
 * across the first 300,000 ms (5 minutes) of active call duration.
 */
export function computeAdaptiveInactivityTimeoutMs(sessionAgeMs: number): number {
  if (!Number.isFinite(sessionAgeMs) || sessionAgeMs <= 0) {
    return INACTIVITY_MIN_TIMEOUT_MS;
  }
  if (sessionAgeMs >= INACTIVITY_RAMP_DURATION_MS) {
    return INACTIVITY_MAX_TIMEOUT_MS;
  }
  const progress = sessionAgeMs / INACTIVITY_RAMP_DURATION_MS;
  return Math.round(
    INACTIVITY_MIN_TIMEOUT_MS +
      progress * (INACTIVITY_MAX_TIMEOUT_MS - INACTIVITY_MIN_TIMEOUT_MS)
  );
}

export type VoiceActivityKind = 'user_speech' | 'user_text' | 'assistant_speech';

export interface SubagentGuardedInactivityTimerOptions {
  hasActiveWork: () => boolean;
  onAutoPause: () => void;
  now?: () => number;
  minTimeoutMs?: number;
  maxTimeoutMs?: number;
  rampDurationMs?: number;
}

/**
 * Adaptive inactivity auto-pause timer that scales timeout with call age and
 * blocks auto-pause whenever active delegated subagents, turns, or pending proposals exist.
 */
export class SubagentGuardedInactivityTimer {
  private readonly hasActiveWork: () => boolean;
  private readonly onAutoPause: () => void;
  private readonly now: () => number;
  private readonly minTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly rampDurationMs: number;

  private timerId: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private paused = false;
  private sessionStartedAtMs = 0;
  private lastActivityAtMs = 0;

  constructor(options: SubagentGuardedInactivityTimerOptions) {
    this.hasActiveWork = options.hasActiveWork;
    this.onAutoPause = options.onAutoPause;
    this.now = options.now ?? (() => Date.now());
    this.minTimeoutMs = options.minTimeoutMs ?? INACTIVITY_MIN_TIMEOUT_MS;
    this.maxTimeoutMs = options.maxTimeoutMs ?? INACTIVITY_MAX_TIMEOUT_MS;
    this.rampDurationMs = options.rampDurationMs ?? INACTIVITY_RAMP_DURATION_MS;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  getCurrentTimeoutMs(): number {
    const ageMs = this.running ? Math.max(0, this.now() - this.sessionStartedAtMs) : 0;
    if (ageMs <= 0) return this.minTimeoutMs;
    if (ageMs >= this.rampDurationMs) return this.maxTimeoutMs;
    const progress = ageMs / this.rampDurationMs;
    return Math.round(
      this.minTimeoutMs + progress * (this.maxTimeoutMs - this.minTimeoutMs)
    );
  }

  start(): void {
    const t = this.now();
    this.sessionStartedAtMs = t;
    this.lastActivityAtMs = t;
    this.paused = false;
    this.running = true;
    this.scheduleNextCheck();
  }

  recordActivity(_kind?: VoiceActivityKind): void {
    if (!this.running) return;
    this.lastActivityAtMs = this.now();
    this.paused = false;
    this.scheduleNextCheck();
  }

  stop(): void {
    this.running = false;
    this.paused = false;
    this.clearScheduledTimer();
  }

  private clearScheduledTimer(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  private scheduleNextCheck(): void {
    this.clearScheduledTimer();
    if (!this.running || this.paused) return;

    const timeoutMs = this.getCurrentTimeoutMs();
    this.timerId = setTimeout(() => {
      this.timerId = null;
      this.handleTimeout();
    }, timeoutMs);
  }

  private handleTimeout(): void {
    if (!this.running || this.paused) return;

    let activeWork = false;
    try {
      activeWork = Boolean(this.hasActiveWork());
    } catch {
      activeWork = false;
    }

    if (activeWork) {
      // Active subagents/turns keep the session alive; grant a fresh quiet window after work completes.
      this.lastActivityAtMs = this.now();
      this.scheduleNextCheck();
      return;
    }

    const elapsed = this.now() - this.lastActivityAtMs;
    const requiredTimeout = this.getCurrentTimeoutMs();
    if (elapsed < requiredTimeout) {
      this.clearScheduledTimer();
      this.timerId = setTimeout(() => {
        this.timerId = null;
        this.handleTimeout();
      }, Math.max(1, requiredTimeout - elapsed));
      return;
    }

    this.paused = true;
    this.onAutoPause();
  }
}

export const DEFAULT_AUTO_SLEEP_WARNING_LEAD_SEC = 15;
const BUSY_HOLD_POLL_MS = 1000;

export interface VoiceInactivityAutoSleepGuardOptions {
  timeoutSec: number;
  warningLeadSec?: number;
  isBusy?: () => boolean;
  now?: () => number;
  onWarn?: (remainingSec: number) => void;
  onTimeout: () => void;
}

/**
 * Tracks continuous audio stream duration and enforces configurable idle auto-sleep
 * (default 180s, 0 = disabled) while holding off whenever speech or Thinker work is busy.
 */
export class VoiceInactivityAutoSleepGuard {
  private timeoutSec: number;
  private readonly explicitWarningLeadSec?: number;
  private readonly isBusy?: () => boolean;
  private readonly now: () => number;
  private readonly onWarn?: (remainingSec: number) => void;
  private readonly onTimeout: () => void;

  private running = false;
  private startedAtMs: number | null = null;
  private stoppedStreamMs = 0;
  private lastActivityAtMs = 0;
  private lastTouchReason?: string;
  private warnedForCurrentIdle = false;

  private warnTimerId: ReturnType<typeof setTimeout> | null = null;
  private timeoutTimerId: ReturnType<typeof setTimeout> | null = null;
  private busyPollTimerId: ReturnType<typeof setTimeout> | null = null;

  constructor(options: VoiceInactivityAutoSleepGuardOptions) {
    this.timeoutSec = VoiceInactivityAutoSleepGuard.normalizeTimeoutSec(options.timeoutSec);
    this.explicitWarningLeadSec = options.warningLeadSec;
    this.isBusy = options.isBusy;
    this.now = options.now ?? (() => Date.now());
    this.onWarn = options.onWarn;
    this.onTimeout = options.onTimeout;
  }

  private static normalizeTimeoutSec(sec: number): number {
    if (!Number.isFinite(sec) || sec <= 0) return 0;
    return sec;
  }

  private getEffectiveWarningLeadSec(): number {
    if (this.timeoutSec <= 0) return 0;
    const raw =
      this.explicitWarningLeadSec !== undefined
        ? this.explicitWarningLeadSec
        : DEFAULT_AUTO_SLEEP_WARNING_LEAD_SEC;
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    if (raw < this.timeoutSec) return raw;
    return this.timeoutSec > 1 ? Math.floor(this.timeoutSec / 2) : 0;
  }

  isRunning(): boolean {
    return this.running;
  }

  getElapsedStreamSeconds(): number {
    if (this.startedAtMs === null) return 0;
    const elapsedMs = this.running
      ? Math.max(0, this.now() - this.startedAtMs)
      : this.stoppedStreamMs;
    return Math.floor(elapsedMs / 1000);
  }

  getLastTouchReason(): string | undefined {
    return this.lastTouchReason;
  }

  start(): void {
    this.clearAllTimers();
    const t = this.now();
    this.startedAtMs = t;
    this.stoppedStreamMs = 0;
    this.lastActivityAtMs = t;
    this.lastTouchReason = undefined;
    this.warnedForCurrentIdle = false;
    this.running = true;
    this.scheduleTimers();
  }

  stop(): void {
    this.clearAllTimers();
    if (this.running && this.startedAtMs !== null) {
      this.stoppedStreamMs = Math.max(0, this.now() - this.startedAtMs);
    }
    this.running = false;
  }

  touch(reason?: string): void {
    if (!this.running) return;
    if (reason !== undefined) {
      this.lastTouchReason = reason;
    }
    this.lastActivityAtMs = this.now();
    this.warnedForCurrentIdle = false;
    this.scheduleTimers();
  }

  setTimeoutSec(sec: number): void {
    const prev = this.timeoutSec;
    this.timeoutSec = VoiceInactivityAutoSleepGuard.normalizeTimeoutSec(sec);
    if (!this.running) return;
    if (prev <= 0 && this.timeoutSec > 0) {
      this.lastActivityAtMs = this.now();
    }
    this.warnedForCurrentIdle = false;
    this.scheduleTimers();
  }

  private clearAllTimers(): void {
    if (this.warnTimerId !== null) {
      clearTimeout(this.warnTimerId);
      this.warnTimerId = null;
    }
    if (this.timeoutTimerId !== null) {
      clearTimeout(this.timeoutTimerId);
      this.timeoutTimerId = null;
    }
    if (this.busyPollTimerId !== null) {
      clearTimeout(this.busyPollTimerId);
      this.busyPollTimerId = null;
    }
  }

  private checkBusy(): boolean {
    if (!this.isBusy) return false;
    try {
      return Boolean(this.isBusy());
    } catch {
      return false;
    }
  }

  private enterBusyHold(): void {
    this.clearAllTimers();
    if (!this.running || this.timeoutSec <= 0) return;
    this.lastActivityAtMs = this.now();
    this.warnedForCurrentIdle = false;
    const pollDelayMs = Math.min(BUSY_HOLD_POLL_MS, Math.max(50, Math.round(this.timeoutSec * 1000)));
    this.busyPollTimerId = setTimeout(() => {
      this.busyPollTimerId = null;
      if (!this.running || this.timeoutSec <= 0) return;
      if (this.checkBusy()) {
        this.enterBusyHold();
        return;
      }
      this.scheduleTimers();
    }, pollDelayMs);
  }

  private scheduleTimers(): void {
    this.clearAllTimers();
    if (!this.running || this.timeoutSec <= 0) return;

    const timeoutMs = this.timeoutSec * 1000;
    const elapsedMs = Math.max(0, this.now() - this.lastActivityAtMs);
    const remainingMs = Math.max(1, timeoutMs - elapsedMs);

    const leadSec = this.getEffectiveWarningLeadSec();
    if (leadSec > 0 && this.onWarn && !this.warnedForCurrentIdle) {
      const warnAtMs = (this.timeoutSec - leadSec) * 1000;
      const warnDelayMs = warnAtMs - elapsedMs;
      if (warnDelayMs <= 0) {
        if (this.checkBusy()) {
          this.enterBusyHold();
          return;
        }
        this.warnedForCurrentIdle = true;
        this.onWarn(Math.max(1, Math.ceil(remainingMs / 1000)));
      } else {
        this.warnTimerId = setTimeout(() => {
          this.warnTimerId = null;
          this.handleWarnFire();
        }, warnDelayMs);
      }
    }

    this.timeoutTimerId = setTimeout(() => {
      this.timeoutTimerId = null;
      this.handleTimeoutFire();
    }, remainingMs);
  }

  private handleWarnFire(): void {
    if (!this.running || this.timeoutSec <= 0 || this.warnedForCurrentIdle) return;
    if (this.checkBusy()) {
      this.enterBusyHold();
      return;
    }
    const timeoutMs = this.timeoutSec * 1000;
    const remainingMs = Math.max(0, timeoutMs - Math.max(0, this.now() - this.lastActivityAtMs));
    if (remainingMs <= 0) return;
    this.warnedForCurrentIdle = true;
    this.onWarn?.(Math.max(1, Math.ceil(remainingMs / 1000)));
  }

  private handleTimeoutFire(): void {
    if (!this.running || this.timeoutSec <= 0) return;
    if (this.checkBusy()) {
      this.enterBusyHold();
      return;
    }
    const timeoutMs = this.timeoutSec * 1000;
    const elapsedMs = Math.max(0, this.now() - this.lastActivityAtMs);
    if (elapsedMs < timeoutMs) {
      this.scheduleTimers();
      return;
    }
    this.stop();
    this.onTimeout();
  }
}

export const VOICE_PLAYBACK_SPEED_MIN = 0.5;
export const VOICE_PLAYBACK_SPEED_MAX = 2.0;
export const VOICE_PLAYBACK_SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/**
 * Clamps TTS playback speed between 0.5x and 2.0x and snaps to 0.05 (or custom) increments.
 */
export function clampVoicePlaybackSpeed(speed: number, step = 0.05): number {
  if (!Number.isFinite(speed)) return 1;
  const safeStep = Number.isFinite(step) && step > 0 ? step : 0.05;
  const clamped = Math.min(VOICE_PLAYBACK_SPEED_MAX, Math.max(VOICE_PLAYBACK_SPEED_MIN, speed));
  const snapped = Math.round(clamped / safeStep) * safeStep;
  const reClamped = Math.min(VOICE_PLAYBACK_SPEED_MAX, Math.max(VOICE_PLAYBACK_SPEED_MIN, snapped));
  return Number(reClamped.toFixed(2));
}

/**
 * Cycles playback speed through [0.75, 1, 1.25, 1.5, 1.75, 2].
 */
export function nextVoicePlaybackSpeed(current: number): number {
  if (!Number.isFinite(current)) return 1;
  const normalized = clampVoicePlaybackSpeed(current);
  for (let i = 0; i < VOICE_PLAYBACK_SPEED_PRESETS.length; i++) {
    const preset = VOICE_PLAYBACK_SPEED_PRESETS[i];
    if (Math.abs(normalized - preset) < 0.001) {
      return VOICE_PLAYBACK_SPEED_PRESETS[(i + 1) % VOICE_PLAYBACK_SPEED_PRESETS.length];
    }
    if (normalized < preset) {
      return preset;
    }
  }
  return VOICE_PLAYBACK_SPEED_PRESETS[0];
}

export function formatVoicePlaybackSpeed(speed: number): string {
  return `${clampVoicePlaybackSpeed(speed)}x`;
}

export interface DeviceHotSwapMonitorOptions {
  stream?: MediaStream | null;
  onTrackEnded?: (track: MediaStreamTrack) => void;
  onDeviceChange?: () => void;
}

/**
 * Subscribes to both MediaStreamTrack 'ended' events and navigator.mediaDevices 'devicechange'
 * to coordinate seamless microphone/speaker hot-swap recovery.
 */
export function watchDeviceHotSwap(options: DeviceHotSwapMonitorOptions): () => void {
  const cleanups: Array<() => void> = [];

  if (options.stream && typeof options.stream.getAudioTracks === 'function' && options.onTrackEnded) {
    const tracks = options.stream.getAudioTracks();
    for (const track of tracks) {
      const handler = () => {
        options.onTrackEnded?.(track);
      };
      if (typeof track.addEventListener === 'function') {
        track.addEventListener('ended', handler);
        cleanups.push(() => {
          try {
            track.removeEventListener('ended', handler);
          } catch {
            // ignore
          }
        });
      }
    }
  }

  if (options.onDeviceChange) {
    cleanups.push(subscribeAudioDeviceChanges(options.onDeviceChange));
  }

  return () => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  };
}
