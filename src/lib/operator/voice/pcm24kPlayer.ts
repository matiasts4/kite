// Kite Code — Low-Latency 24 kHz PCM16 Audio Player & Active Audio Clock Registry
// Decodes little-endian Int16 PCM streams (base64, ArrayBuffer, or Uint8Array) into gapless
// Web Audio buffers with 20 ms barge-in fade-out, AnalyserNode RMS metering, and S2 timing sync.

export interface Pcm24kAudioSpan {
  startAt: number;
  endAt: number;
}

export interface Pcm24kTiming {
  currentTime: number;
  scheduledEnd: number;
}

export interface Pcm24kPlayer {
  enqueuePcm24k: (
    chunk: ArrayBuffer | Uint8Array | string,
    sampleRate?: number
  ) => Pcm24kAudioSpan | null;
  clearWithRamp: (rampMs?: number) => void;
  getSpeakerLevel: () => number;
  getTiming: () => Pcm24kTiming;
  setVolume: (volume: number) => void;
  setPlaybackRate: (rate: number) => void;
  close: () => void;
}

const DEFAULT_SAMPLE_RATE = 24000;
const MIN_PLAYBACK_RATE = 0.5;
const MAX_PLAYBACK_RATE = 2.0;
const ANALYSER_FFT_SIZE = 256;
const RMS_LEVEL_GAIN = 5;

let activeTimingGetter: (() => number) | null = null;

/**
 * Registers the live playback clock getter so `VoiceTeleprompterDock` can read
 * `AudioContext.currentTime` at 60 fps without tight coupling to the player instance.
 */
export function registerActiveVoiceAudioTimingGetter(
  getter: (() => number) | null
): void {
  activeTimingGetter = getter;
}

/**
 * Returns the active voice `AudioContext.currentTime` in seconds, or `0` when idle.
 */
export function getActiveVoiceAudioTime(): number {
  if (!activeTimingGetter) return 0;
  try {
    const val = activeTimingGetter();
    return Number.isFinite(val) && val >= 0 ? val : 0;
  } catch {
    return 0;
  }
}

type AudioContextCtor = new (contextOptions?: AudioContextOptions) => AudioContext;

function resolveAudioContextCtor(): AudioContextCtor | null {
  if (typeof window !== 'undefined') {
    const winCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (typeof winCtor === 'function') return winCtor;
  }
  if (typeof globalThis !== 'undefined') {
    const globalCtor = (globalThis as unknown as { AudioContext?: AudioContextCtor }).AudioContext;
    if (typeof globalCtor === 'function') return globalCtor;
  }
  return null;
}

function normalizeVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 1;
  if (volume <= 0) return 0;
  if (volume <= 1) return volume;
  return Math.min(1, volume / 100);
}

function clampPlaybackRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, rate));
}

function decodeBase64ToBytes(raw: string): Uint8Array | null {
  const cleaned = raw.replace(/\s+/g, '');
  if (!cleaned) return null;

  const standard = cleaned.replace(/-/g, '+').replace(/_/g, '/');
  try {
    if (typeof atob === 'function') {
      const binary = atob(standard);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        out[i] = binary.charCodeAt(i);
      }
      return out;
    }
    const globalBuffer = (
      globalThis as unknown as {
        Buffer?: { from: (input: string, encoding: string) => Uint8Array };
      }
    ).Buffer;
    if (globalBuffer && typeof globalBuffer.from === 'function') {
      const buf = globalBuffer.from(standard, 'base64');
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    return null;
  } catch (err) {
    console.warn('[Pcm24kPlayer] Failed to decode base64 PCM chunk:', err);
    return null;
  }
}

function chunkToBytes(chunk: ArrayBuffer | Uint8Array | string): Uint8Array | null {
  if (typeof chunk === 'string') {
    return decodeBase64ToBytes(chunk);
  }
  if (chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk);
  }
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return null;
}

function pcm16LittleEndianToFloat32(bytes: Uint8Array): Float32Array | null {
  const sampleCount = Math.floor(bytes.byteLength / 2);
  if (sampleCount <= 0) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  const floatSamples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    const int16 = view.getInt16(i * 2, true);
    floatSamples[i] = int16 < 0 ? int16 / 32768 : int16 / 32767;
  }
  return floatSamples;
}

function setGainValueImmediate(gainNode: GainNode, value: number, time: number): void {
  const param = gainNode.gain;
  if (typeof param.setValueAtTime === 'function') {
    param.setValueAtTime(value, time);
  }
  param.value = value;
}

export function createPcm24kPlayer(initialVolume = 1): Pcm24kPlayer {
  let ctx: AudioContext | null = null;
  let rampGain: GainNode | null = null;
  let masterGain: GainNode | null = null;
  let analyser: AnalyserNode | null = null;

  let masterVolume = normalizeVolume(initialVolume);
  let playbackRate = 1;
  let scheduledEnd = 0;
  let clearEpoch = 0;
  let isClosed = false;

  const activeSources = new Set<AudioBufferSourceNode>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  let floatTimeBuffer: Float32Array<ArrayBuffer> | null = null;
  let byteTimeBuffer: Uint8Array<ArrayBuffer> | null = null;

  const ensureGraph = (): boolean => {
    if (isClosed) return false;
    if (ctx && rampGain && masterGain) return true;

    const AudioCtx = resolveAudioContextCtor();
    if (!AudioCtx) return false;

    try {
      ctx = new AudioCtx({ latencyHint: 'playback' });
    } catch {
      try {
        ctx = new AudioCtx();
      } catch (err) {
        console.warn('[Pcm24kPlayer] AudioContext initialization failed:', err);
        return false;
      }
    }

    rampGain = ctx.createGain();
    masterGain = ctx.createGain();
    setGainValueImmediate(rampGain, 1, ctx.currentTime);
    setGainValueImmediate(masterGain, masterVolume, ctx.currentTime);

    analyser = typeof ctx.createAnalyser === 'function' ? ctx.createAnalyser() : null;
    if (analyser) {
      analyser.fftSize = ANALYSER_FFT_SIZE;
    }

    rampGain.connect(masterGain);
    if (analyser && typeof analyser.connect === 'function') {
      masterGain.connect(analyser);
      analyser.connect(ctx.destination);
    } else {
      masterGain.connect(ctx.destination);
    }

    return true;
  };

  // Initialize eagerly when Web Audio is present so timing/gain state are ready immediately.
  ensureGraph();

  const enqueuePcm24k = (
    chunk: ArrayBuffer | Uint8Array | string,
    sampleRate = DEFAULT_SAMPLE_RATE
  ): Pcm24kAudioSpan | null => {
    if (isClosed || !ensureGraph() || !ctx || !rampGain) {
      return null;
    }

    const bytes = chunkToBytes(chunk);
    if (!bytes) return null;

    const floatSamples = pcm16LittleEndianToFloat32(bytes);
    if (!floatSamples) return null;

    const safeRate =
      Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : DEFAULT_SAMPLE_RATE;

    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      void ctx.resume().catch((err) => {
        console.warn('[Pcm24kPlayer] Failed to resume AudioContext:', err);
      });
    }

    const buffer = ctx.createBuffer(1, floatSamples.length, safeRate);
    if (typeof buffer.getChannelData === 'function') {
      buffer.getChannelData(0).set(floatSamples);
    } else if (typeof buffer.copyToChannel === 'function') {
      buffer.copyToChannel(new Float32Array(floatSamples), 0);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    if (source.playbackRate && typeof source.playbackRate.value === 'number') {
      source.playbackRate.value = playbackRate;
    }
    source.connect(rampGain);

    const startAt = Math.max(ctx.currentTime, scheduledEnd);
    const nominalDuration =
      buffer.duration && Number.isFinite(buffer.duration)
        ? buffer.duration
        : floatSamples.length / safeRate;
    const endAt = startAt + nominalDuration / playbackRate;
    scheduledEnd = endAt;

    activeSources.add(source);
    source.onended = () => {
      activeSources.delete(source);
      try {
        source.disconnect();
      } catch {
        // node may already be disconnected on close/clear
      }
    };

    source.start(startAt);
    return { startAt, endAt };
  };

  const clearWithRamp = (rampMs = 20): void => {
    scheduledEnd = 0;
    if (isClosed || !ctx || !rampGain) return;

    const safeRampMs = Number.isFinite(rampMs) && rampMs > 0 ? rampMs : 0;
    const now = ctx.currentTime;
    const gainParam = rampGain.gain;

    if (typeof gainParam.cancelScheduledValues === 'function') {
      gainParam.cancelScheduledValues(now);
    }
    const currentGain = typeof gainParam.value === 'number' ? gainParam.value : 1;
    if (typeof gainParam.setValueAtTime === 'function') {
      gainParam.setValueAtTime(currentGain, now);
    }
    if (typeof gainParam.linearRampToValueAtTime === 'function') {
      gainParam.linearRampToValueAtTime(0, now + safeRampMs / 1000);
    } else {
      gainParam.value = 0;
    }

    const sourcesToStop = Array.from(activeSources);
    activeSources.clear();

    clearEpoch += 1;
    const myEpoch = clearEpoch;

    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      for (const src of sourcesToStop) {
        try {
          src.stop();
        } catch {
          // source may have already finished
        }
        try {
          src.disconnect();
        } catch {
          // ignore already-disconnected node
        }
      }

      if (!isClosed && myEpoch === clearEpoch && ctx && rampGain) {
        const restoreAt = ctx.currentTime;
        const restoreParam = rampGain.gain;
        if (typeof restoreParam.cancelScheduledValues === 'function') {
          restoreParam.cancelScheduledValues(restoreAt);
        }
        setGainValueImmediate(rampGain, 1, restoreAt);
      }
    }, safeRampMs + 5);

    pendingTimers.add(timer);
  };

  const getSpeakerLevel = (): number => {
    if (isClosed || !ctx || !analyser || ctx.state === 'closed' || ctx.state === 'suspended') {
      return 0;
    }

    const fftSize = analyser.fftSize || ANALYSER_FFT_SIZE;
    let sumSquares = 0;

    if (typeof analyser.getFloatTimeDomainData === 'function') {
      if (!floatTimeBuffer || floatTimeBuffer.length !== fftSize) {
        floatTimeBuffer = new Float32Array(new ArrayBuffer(fftSize * 4));
      } else {
        floatTimeBuffer.fill(0);
      }
      analyser.getFloatTimeDomainData(floatTimeBuffer);
      for (let i = 0; i < floatTimeBuffer.length; i += 1) {
        const sample = floatTimeBuffer[i];
        sumSquares += sample * sample;
      }
      const rms = Math.sqrt(sumSquares / floatTimeBuffer.length);
      return Math.min(1, Math.max(0, rms * RMS_LEVEL_GAIN));
    }

    if (typeof analyser.getByteTimeDomainData === 'function') {
      if (!byteTimeBuffer || byteTimeBuffer.length !== fftSize) {
        byteTimeBuffer = new Uint8Array(new ArrayBuffer(fftSize));
      }
      byteTimeBuffer.fill(128);
      analyser.getByteTimeDomainData(byteTimeBuffer);
      for (let i = 0; i < byteTimeBuffer.length; i += 1) {
        const normalized = (byteTimeBuffer[i] - 128) / 128;
        sumSquares += normalized * normalized;
      }
      const rms = Math.sqrt(sumSquares / byteTimeBuffer.length);
      return Math.min(1, Math.max(0, rms * RMS_LEVEL_GAIN));
    }

    return 0;
  };

  const getTiming = (): Pcm24kTiming => {
    if (isClosed || !ctx) {
      return { currentTime: 0, scheduledEnd: 0 };
    }
    return {
      currentTime: Number.isFinite(ctx.currentTime) ? ctx.currentTime : 0,
      scheduledEnd,
    };
  };

  const setVolume = (volume: number): void => {
    masterVolume = normalizeVolume(volume);
    if (!isClosed && ctx && masterGain) {
      setGainValueImmediate(masterGain, masterVolume, ctx.currentTime);
    }
  };

  const setPlaybackRate = (rate: number): void => {
    playbackRate = clampPlaybackRate(rate);
    for (const src of activeSources) {
      if (src.playbackRate && typeof src.playbackRate.value === 'number') {
        src.playbackRate.value = playbackRate;
      }
    }
  };

  const close = (): void => {
    if (isClosed) return;
    isClosed = true;
    scheduledEnd = 0;
    clearEpoch += 1;

    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers.clear();

    for (const src of activeSources) {
      try {
        src.stop();
      } catch {
        // ignore stopped source
      }
      try {
        src.disconnect();
      } catch {
        // ignore disconnected source
      }
    }
    activeSources.clear();

    for (const node of [rampGain, masterGain, analyser]) {
      if (!node) continue;
      try {
        node.disconnect();
      } catch {
        // ignore disconnect failure
      }
    }

    if (ctx && ctx.state !== 'closed' && typeof ctx.close === 'function') {
      try {
        void Promise.resolve(ctx.close()).catch((err) => {
          console.warn('[Pcm24kPlayer] Failed to close AudioContext:', err);
        });
      } catch (err) {
        console.warn('[Pcm24kPlayer] AudioContext close error:', err);
      }
    }

    rampGain = null;
    masterGain = null;
    analyser = null;
    ctx = null;
  };

  return {
    enqueuePcm24k,
    clearWithRamp,
    getSpeakerLevel,
    getTiming,
    setVolume,
    setPlaybackRate,
    close,
  };
}
