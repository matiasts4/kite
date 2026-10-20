/**
 * Kite Code — Audio Ducking & Zen Earcon Sound Cues
 * Parity with Veloce audio engine:
 *  - Ethereal singing bowl Zen chord on recording start and stop (synthesized via Web Audio API)
 *  - Windows Core Audio master volume ducking to 20% on start, smooth restoration on stop
 *  - Strictly the 'zen' sound cue only (no other themes or selectors).
 */

import { isTauriEnvironment, operatorDuckAudio, operatorRestoreAudio } from '../../ipc';

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    sharedAudioCtx = new AudioCtx();
  }
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

export function _resetAudioContextForTesting(): void {
  sharedAudioCtx = null;
  isCurrentlyDucked = false;
}

/**
 * Synthesizes and plays the acoustically pleasant "Zen" sound cue
 * using Web Audio API with zero latency and smooth exponential decay.
 *
 * Start: F4 (349.23 Hz) + C5 (523.25 Hz) singing bowl chord
 * Stop:  G4 (392.00 Hz) + D5 (587.33 Hz) resolving cadence
 */
export function playZenCue(start: boolean): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const sampleRate = ctx.sampleRate || 44100;
    const durationSecs = 0.22;
    const numSamples = Math.floor(sampleRate * durationSecs);
    const buffer = ctx.createBuffer(1, numSamples, sampleRate);
    const channelData = buffer.getChannelData(0);

    const f1 = start ? 349.23 : 392.00;
    const f2 = start ? 523.25 : 587.33;

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const attack = Math.min(1.0, t / 0.025);
      const decay = Math.exp(-t * 12.0);
      const tone =
        Math.sin(2.0 * Math.PI * f1 * t) +
        0.5 * Math.sin(2.0 * Math.PI * f2 * t);
      const amp = 0.16 * attack * decay * tone;
      channelData[i] = Math.max(-1.0, Math.min(1.0, amp));
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
  } catch (err) {
    console.warn('[AudioDucking] No se pudo reproducir tono Zen web:', err);
  }
}

let isCurrentlyDucked = false;

/**
 * Starts audio ducking (reduces system volume to 20%) and plays the Zen start chime.
 */
export async function startAudioDucking(): Promise<void> {
  isCurrentlyDucked = true;

  // 1. Play Zen start chime instantly
  playZenCue(true);

  // 2. Trigger native Windows WASAPI ducking if running inside Tauri
  if (isTauriEnvironment()) {
    try {
      await operatorDuckAudio(0.20);
    } catch {
      // ignore
    }
  }
}

/**
 * Stops audio ducking (restores system volume to original level),
 * waits 60ms for the curve to initialize, and plays the Zen stop chime.
 */
export async function stopAudioDucking(): Promise<void> {
  if (!isCurrentlyDucked) return;
  isCurrentlyDucked = false;

  // 1. Restore native Windows volume
  if (isTauriEnvironment()) {
    try {
      await operatorRestoreAudio();
    } catch {
      // ignore
    }
  }

  // 2. Short 60ms acoustic delay matching Veloce so volume return has begun
  setTimeout(() => {
    playZenCue(false);
  }, 60);
}
