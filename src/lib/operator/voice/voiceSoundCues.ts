// Kite Code — Synthesized Web Audio Acoustic Cues for Voice Mode (S4)
// Zero-asset Web Audio cue synthesis routed through a warm lowpass feedback delay bus.

const LOWPASS_CUTOFF_HZ = 2200;
const FEEDBACK_DELAY_SEC = 0.095;
const FEEDBACK_GAIN = 0.16;
const WET_RETURN_GAIN = 0.32;
const RECONNECT_INITIAL_DELAY_MS = 1000;
const RECONNECT_INTERVAL_MS = 2000;

let sharedAudioCtx: AudioContext | null = null;

function getAudioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window !== 'undefined') {
    return (
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    );
  }
  return (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
}

function normalizeCueVolume(volume = 1): number {
  if (!Number.isFinite(volume)) return 0;
  const scaled = volume > 1 ? volume / 100 : volume;
  return Math.min(1, Math.max(0, scaled));
}

function ensureAudioContext(): AudioContext | null {
  const AudioCtx = getAudioContextConstructor();
  if (!AudioCtx) return null;

  try {
    if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
      sharedAudioCtx = new AudioCtx();
    }
    if (sharedAudioCtx.state === 'suspended') {
      void sharedAudioCtx.resume().catch((err) => {
        console.warn('[VoiceSoundCues] AudioContext resume failed:', err);
      });
    }
    return sharedAudioCtx;
  } catch (err) {
    console.warn('[VoiceSoundCues] AudioContext unavailable:', err);
    return null;
  }
}

interface CueSweep {
  startFreq: number;
  endFreq: number;
  durationSec: number;
  offsetSec: number;
  peakGain: number;
}

function createFeedbackDelayBus(
  ctx: AudioContext,
  now: number,
  normalizedVolume: number,
): AudioNode {
  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(normalizedVolume, now);
  masterGain.connect(ctx.destination);

  if (typeof ctx.createDelay === 'function' && typeof ctx.createBiquadFilter === 'function') {
    const busInput = ctx.createGain();
    busInput.gain.setValueAtTime(1, now);
    busInput.connect(masterGain);

    const delay = ctx.createDelay(0.5);
    delay.delayTime.setValueAtTime(FEEDBACK_DELAY_SEC, now);

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.setValueAtTime(LOWPASS_CUTOFF_HZ, now);

    const feedback = ctx.createGain();
    feedback.gain.setValueAtTime(FEEDBACK_GAIN, now);

    const wetGain = ctx.createGain();
    wetGain.gain.setValueAtTime(WET_RETURN_GAIN, now);

    busInput.connect(delay);
    delay.connect(lowpass);
    lowpass.connect(feedback);
    feedback.connect(delay);
    lowpass.connect(wetGain);
    wetGain.connect(masterGain);

    return busInput;
  }

  return masterGain;
}

function scheduleSweeps(
  ctx: AudioContext,
  normalizedVolume: number,
  sweeps: readonly CueSweep[],
): void {
  const baseTime = ctx.currentTime || 0;
  const bus = createFeedbackDelayBus(ctx, baseTime, normalizedVolume);

  for (const sweep of sweeps) {
    const startAt = baseTime + sweep.offsetSec;
    const endAt = startAt + sweep.durationSec;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(sweep.startFreq, startAt);
    osc.frequency.exponentialRampToValueAtTime(sweep.endFreq, endAt);

    const env = ctx.createGain();
    const attackEnd = startAt + Math.min(0.015, sweep.durationSec * 0.25);
    env.gain.setValueAtTime(0.0001, startAt);
    env.gain.exponentialRampToValueAtTime(sweep.peakGain, attackEnd);
    env.gain.exponentialRampToValueAtTime(0.0001, endAt);

    osc.connect(env);
    env.connect(bus);
    osc.start(startAt);
    osc.stop(endAt + 0.02);
  }
}

export function playVoiceConnectCue(volume = 1): void {
  const normalized = normalizeCueVolume(volume);
  if (normalized <= 0) return;
  const ctx = ensureAudioContext();
  if (!ctx) return;

  try {
    scheduleSweeps(ctx, normalized, [
      { startFreq: 260, endFreq: 310, durationSec: 0.065, offsetSec: 0, peakGain: 0.14 },
      { startFreq: 340, endFreq: 420, durationSec: 0.085, offsetSec: 0.055, peakGain: 0.16 },
    ]);
  } catch (err) {
    console.warn('[VoiceSoundCues] Connect cue failed:', err);
  }
}

export function playVoiceDisconnectCue(volume = 1): void {
  const normalized = normalizeCueVolume(volume);
  if (normalized <= 0) return;
  const ctx = ensureAudioContext();
  if (!ctx) return;

  try {
    scheduleSweeps(ctx, normalized, [
      { startFreq: 380, endFreq: 320, durationSec: 0.065, offsetSec: 0, peakGain: 0.14 },
      { startFreq: 280, endFreq: 220, durationSec: 0.085, offsetSec: 0.055, peakGain: 0.14 },
    ]);
  } catch (err) {
    console.warn('[VoiceSoundCues] Disconnect cue failed:', err);
  }
}

export function playVoiceErrorCue(volume = 1): void {
  const normalized = normalizeCueVolume(volume);
  if (normalized <= 0) return;
  const ctx = ensureAudioContext();
  if (!ctx) return;

  try {
    scheduleSweeps(ctx, normalized, [
      { startFreq: 147, endFreq: 91, durationSec: 0.14, offsetSec: 0, peakGain: 0.18 },
      { startFreq: 147, endFreq: 91, durationSec: 0.16, offsetSec: 0.16, peakGain: 0.2 },
    ]);
  } catch (err) {
    console.warn('[VoiceSoundCues] Error cue failed:', err);
  }
}

export function playVoiceReadyCue(volume = 1): void {
  const normalized = normalizeCueVolume(volume);
  if (normalized <= 0) return;
  const ctx = ensureAudioContext();
  if (!ctx) return;

  try {
    scheduleSweeps(ctx, normalized, [
      { startFreq: 520, endFreq: 660, durationSec: 0.085, offsetSec: 0, peakGain: 0.075 },
    ]);
  } catch (err) {
    console.warn('[VoiceSoundCues] Ready cue failed:', err);
  }
}

export function startVoiceReconnectPulse(
  isSuppressed: () => boolean,
  volume = 1,
): () => void {
  const normalized = normalizeCueVolume(volume);
  if (normalized <= 0) {
    return () => {};
  }

  const ctx = ensureAudioContext();
  if (!ctx) {
    return () => {};
  }

  let stopped = false;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const triggerPulse = () => {
    if (stopped) return;
    try {
      if (isSuppressed()) return;
      if (ctx.state === 'closed') return;
      if (ctx.state === 'suspended') {
        void ctx.resume().catch((err) => {
          console.warn('[VoiceSoundCues] Reconnect pulse resume failed:', err);
        });
      }
      scheduleSweeps(ctx, normalized, [
        { startFreq: 300, endFreq: 340, durationSec: 0.12, offsetSec: 0, peakGain: 0.085 },
      ]);
    } catch (err) {
      console.warn('[VoiceSoundCues] Reconnect pulse failed:', err);
    }
  };

  initialTimer = setTimeout(() => {
    initialTimer = null;
    if (stopped) return;
    triggerPulse();
    intervalId = setInterval(triggerPulse, RECONNECT_INTERVAL_MS);
  }, RECONNECT_INITIAL_DELAY_MS);

  return () => {
    stopped = true;
    if (initialTimer !== null) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (ctx.state !== 'closed' && typeof ctx.close === 'function') {
      void ctx.close().catch((err) => {
        console.warn('[VoiceSoundCues] AudioContext close failed:', err);
      });
    }
    if (sharedAudioCtx === ctx) {
      sharedAudioCtx = null;
    }
  };
}

export function _resetVoiceSoundCuesForTesting(): void {
  if (sharedAudioCtx && sharedAudioCtx.state !== 'closed' && typeof sharedAudioCtx.close === 'function') {
    void sharedAudioCtx.close().catch(() => {});
  }
  sharedAudioCtx = null;
}
