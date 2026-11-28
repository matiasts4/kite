// Kite Code — Adaptive VAD, Pre-Roll Ring Buffer & Acoustic Barge-In Gate
// Replaces static RMS thresholds and fixed 2.4s silence windows with ambient noise calibration,
// Schmitt-trigger hysteresis, syntactic Spanish endpointing, and echo-resistant barge-in detection.

import { isSpanishOpenClause } from './speechPartial';

export interface AdaptiveVadConfig {
  minOnsetRms?: number;
  minReleaseRms?: number;
  onsetMultiplier?: number;
  releaseMultiplier?: number;
  noiseFloorAlpha?: number;
  initialNoiseFloorRms?: number;
  minSpeechOnsetMs?: number;
}

export interface VadFrameDecision {
  rms: number;
  noiseFloorRms: number;
  onsetThreshold: number;
  releaseThreshold: number;
  isVoiced: boolean;
  speechStartedNow: boolean;
}

export function computeRms(samples: Float32Array): number {
  if (!samples || samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples.length);
}

/**
 * Circular PCM Float32 ring buffer preserving the last `durationMs` of audio
 * so acoustic barge-in never clips the user's opening syllables.
 */
export class PcmPreRollBuffer {
  private readonly maxSamples: number;
  private chunks: Float32Array[] = [];
  private totalSamples = 0;

  constructor(sampleRate: number = 16000, durationMs: number = 400) {
    this.maxSamples = Math.max(1024, Math.round((sampleRate * durationMs) / 1000));
  }

  public push(samples: Float32Array): void {
    if (!samples || samples.length === 0) return;
    const copy = new Float32Array(samples);
    this.chunks.push(copy);
    this.totalSamples += copy.length;

    while (this.totalSamples > this.maxSamples && this.chunks.length > 1) {
      const oldest = this.chunks[0];
      if (this.totalSamples - oldest.length >= this.maxSamples) {
        this.chunks.shift();
        this.totalSamples -= oldest.length;
      } else {
        const overflow = this.totalSamples - this.maxSamples;
        this.chunks[0] = oldest.slice(overflow);
        this.totalSamples -= overflow;
      }
    }
  }

  public drain(): Float32Array[] {
    const out = this.chunks;
    this.chunks = [];
    this.totalSamples = 0;
    return out;
  }

  public snapshot(): Float32Array[] {
    return this.chunks.map((c) => new Float32Array(c));
  }

  public clear(): void {
    this.chunks = [];
    this.totalSamples = 0;
  }

  public getSampleCount(): number {
    return this.totalSamples;
  }
}

export type PreConnectBufferState = 'buffering' | 'live';

export interface PreConnectAudioRingBufferConfig {
  maxDurationMs?: number;
  sampleRate?: number;
  leadingSilenceThreshold?: number;
  preRollMs?: number;
}

/**
 * 15-30s circular PCM ring buffer used during session/WebSocket/mic warmup ("buffering" -> "live").
 * On `releaseAndDrain()`, trims leading dead silence while retaining `preRollMs` (default 100ms)
 * before the first voiced frame (`rms >= leadingSilenceThreshold`) so opening words are never clipped.
 */
export class PreConnectAudioRingBuffer {
  private maxDurationMs: number;
  private sampleRate: number;
  private leadingSilenceThreshold: number;
  private preRollMs: number;
  private maxSamples: number;
  private preRollSamples: number;

  private state: PreConnectBufferState = 'buffering';
  private chunks: Float32Array[] = [];
  private totalSamples = 0;

  constructor(
    configOrMaxDurationMs: PreConnectAudioRingBufferConfig | number = {},
    sampleRate: number = 16000,
    leadingSilenceThreshold: number = 0.003,
    preRollMs: number = 100
  ) {
    const cfg: PreConnectAudioRingBufferConfig =
      typeof configOrMaxDurationMs === 'number'
        ? {
            maxDurationMs: configOrMaxDurationMs,
            sampleRate,
            leadingSilenceThreshold,
            preRollMs,
          }
        : configOrMaxDurationMs;

    this.maxDurationMs = Math.max(100, cfg.maxDurationMs ?? 20000);
    this.sampleRate = Math.max(8000, cfg.sampleRate ?? 16000);
    this.leadingSilenceThreshold = Math.max(0, cfg.leadingSilenceThreshold ?? 0.003);
    this.preRollMs = Math.max(0, cfg.preRollMs ?? 100);
    this.maxSamples = Math.max(1, Math.round((this.sampleRate * this.maxDurationMs) / 1000));
    this.preRollSamples = Math.max(0, Math.round((this.sampleRate * this.preRollMs) / 1000));
  }

  public getState(): PreConnectBufferState {
    return this.state;
  }

  public getSampleCount(): number {
    return this.totalSamples;
  }

  public getDurationMs(): number {
    return Math.round((this.totalSamples / this.sampleRate) * 1000);
  }

  public push(samples: Float32Array): void {
    if (this.state !== 'buffering' || !samples || samples.length === 0) return;
    const copy = new Float32Array(samples);
    this.chunks.push(copy);
    this.totalSamples += copy.length;

    while (this.totalSamples > this.maxSamples && this.chunks.length > 0) {
      const oldest = this.chunks[0];
      if (this.totalSamples - oldest.length >= this.maxSamples) {
        this.chunks.shift();
        this.totalSamples -= oldest.length;
      } else {
        const overflow = this.totalSamples - this.maxSamples;
        this.chunks[0] = oldest.slice(overflow);
        this.totalSamples -= overflow;
        break;
      }
    }
  }

  public clear(): void {
    this.chunks = [];
    this.totalSamples = 0;
  }

  public reset(nextSampleRate?: number): void {
    if (typeof nextSampleRate === 'number' && Number.isFinite(nextSampleRate) && nextSampleRate > 0) {
      this.sampleRate = Math.max(8000, nextSampleRate);
      this.maxSamples = Math.max(1, Math.round((this.sampleRate * this.maxDurationMs) / 1000));
      this.preRollSamples = Math.max(0, Math.round((this.sampleRate * this.preRollMs) / 1000));
    }
    this.clear();
    this.state = 'buffering';
  }

  public releaseAndDrain(): Float32Array[] {
    const drained = this.chunks;
    this.chunks = [];
    this.totalSamples = 0;
    this.state = 'live';

    if (drained.length === 0) return [];
    if (this.leadingSilenceThreshold <= 0) {
      return drained;
    }

    const windowSamples = Math.max(16, Math.round((this.sampleRate * 10) / 1000));
    let firstVoicedSample = -1;
    let globalOffset = 0;

    for (const chunk of drained) {
      for (let i = 0; i < chunk.length; i += windowSamples) {
        const end = Math.min(chunk.length, i + windowSamples);
        const len = end - i;
        let sumSq = 0;
        for (let j = i; j < end; j++) {
          const s = chunk[j];
          sumSq += s * s;
        }
        const rms = Math.sqrt(sumSq / len);
        if (rms >= this.leadingSilenceThreshold) {
          firstVoicedSample = globalOffset + i;
          break;
        }
      }
      if (firstVoicedSample >= 0) break;
      globalOffset += chunk.length;
    }

    // All buffered audio was dead silence below threshold
    if (firstVoicedSample < 0) {
      return [];
    }

    const keepFromSample = Math.max(0, firstVoicedSample - this.preRollSamples);
    if (keepFromSample === 0) {
      return drained;
    }

    const result: Float32Array[] = [];
    let cursor = 0;
    for (const chunk of drained) {
      const chunkEnd = cursor + chunk.length;
      if (chunkEnd <= keepFromSample) {
        cursor = chunkEnd;
        continue;
      }
      if (cursor < keepFromSample) {
        result.push(chunk.slice(keepFromSample - cursor));
      } else {
        result.push(chunk);
      }
      cursor = chunkEnd;
    }

    return result;
  }
}

/**
 * Strips up to `samplesToTrim` samples from the end of a chunked PCM buffer
 * without mutating the caller's original arrays. Used to remove dead trailing
 * endpointing silence while preserving a short acoustic decay pad.
 */
export function trimTrailingPcmSamples(
  chunks: Float32Array[],
  samplesToTrim: number
): Float32Array[] {
  if (!chunks || chunks.length === 0) return [];
  let remainingToTrim = Math.floor(samplesToTrim);
  if (!Number.isFinite(remainingToTrim) || remainingToTrim <= 0) {
    return chunks.slice();
  }

  const out = chunks.slice();
  while (remainingToTrim > 0 && out.length > 0) {
    const last = out[out.length - 1];
    if (last.length <= remainingToTrim) {
      remainingToTrim -= last.length;
      out.pop();
    } else {
      out[out.length - 1] = last.subarray(0, last.length - remainingToTrim);
      remainingToTrim = 0;
    }
  }
  return out;
}

/**
 * Ambient-calibrated Voice Activity Detector with Schmitt-trigger hysteresis
 * and minimum sustained onset duration to reject brief clicks/pops.
 */
export class AdaptiveVadController {
  private readonly minOnsetRms: number;
  private readonly minReleaseRms: number;
  private readonly onsetMultiplier: number;
  private readonly releaseMultiplier: number;
  private readonly noiseFloorAlpha: number;
  private readonly minSpeechOnsetMs: number;

  private noiseFloorRms: number;
  private voiced = false;
  private speechConfirmed = false;
  private onsetAccumulatorMs = 0;
  private calibrationFrames = 0;

  constructor(config: AdaptiveVadConfig = {}) {
    this.minOnsetRms = config.minOnsetRms ?? 0.016;
    this.minReleaseRms = config.minReleaseRms ?? 0.010;
    this.onsetMultiplier = config.onsetMultiplier ?? 2.8;
    this.releaseMultiplier = config.releaseMultiplier ?? 1.6;
    this.noiseFloorAlpha = config.noiseFloorAlpha ?? 0.08;
    this.minSpeechOnsetMs = config.minSpeechOnsetMs ?? 120;
    this.noiseFloorRms = config.initialNoiseFloorRms ?? 0.006;
  }

  public resetTurn(preserveNoiseFloor = true): void {
    this.voiced = false;
    this.speechConfirmed = false;
    this.onsetAccumulatorMs = 0;
    if (!preserveNoiseFloor) {
      this.noiseFloorRms = 0.004;
      this.calibrationFrames = 0;
    }
  }

  public getNoiseFloorRms(): number {
    return this.noiseFloorRms;
  }

  public processFrame(rms: number, frameDurationMs: number): VadFrameDecision {
    const clampedRms = Number.isFinite(rms) && rms > 0 ? rms : 0;
    const onsetThreshold = Math.max(this.minOnsetRms, this.noiseFloorRms * this.onsetMultiplier);
    const releaseThreshold = Math.max(this.minReleaseRms, this.noiseFloorRms * this.releaseMultiplier);

    let speechStartedNow = false;

    if (!this.voiced) {
      if (clampedRms >= onsetThreshold) {
        this.onsetAccumulatorMs += frameDurationMs;
        if (this.onsetAccumulatorMs >= this.minSpeechOnsetMs) {
          this.voiced = true;
          if (!this.speechConfirmed) {
            this.speechConfirmed = true;
            speechStartedNow = true;
          }
        }
      } else {
        this.onsetAccumulatorMs = 0;
        // Adapt ambient noise floor only on non-voiced frames
        const alpha = this.calibrationFrames < 6 ? 0.35 : this.noiseFloorAlpha;
        this.calibrationFrames += 1;
        this.noiseFloorRms = Math.min(
          0.08,
          Math.max(0.001, this.noiseFloorRms * (1 - alpha) + clampedRms * alpha)
        );
      }
    } else if (clampedRms < releaseThreshold) {
      this.voiced = false;
      this.onsetAccumulatorMs = 0;
    }

    return {
      rms: clampedRms,
      noiseFloorRms: this.noiseFloorRms,
      onsetThreshold,
      releaseThreshold,
      isVoiced: this.voiced,
      speechStartedNow,
    };
  }
}

const COMPLETE_SHORT_COMMAND_RE =
  /^(?:hola|silencio|c[aá]llate|callate|para|det[eé]n|gracias|listo|s[ií]|no|ok|okey|vale|dale|cancelar|d[eé]jalo|olv[ií]dalo|(?:cierra|sierra|abre|resume|enfoca|iguala)\s+\S+(?:\s+\S+){0,4})$/i;

/**
 * Computes an adaptive end-of-speech trailing silence window (700ms–2100ms)
 * based on interim Spanish syntax and utterance duration.
 * - Complete/closed utterances settle quickly (700–750ms) to minimize latency.
 * - Normal multi-word clauses maintain at least a 950ms floor so natural pauses do not cut off speech.
 * - Mid-clause pauses after conjunctions/hesitations hold open (1850–2100ms) to avoid premature cutoffs.
 */
export function computeAdaptiveEndpointMs(
  interimText: string = '',
  speechDurationMs: number = 0
): number {
  const clean = interimText.trim();

  if (!clean) {
    // No interim transcript available (e.g. Web Speech inactive): use balanced adaptive timing
    if (speechDurationMs > 0 && speechDurationMs < 1800) {
      return 950;
    }
    return 1250;
  }

  if (isSpanishOpenClause(clean)) {
    return 1950;
  }

  if (/[.!?]\s*$/.test(clean) && !/(?:\.\.\.|…)\s*$/.test(clean)) {
    return 700;
  }

  const wordCount = clean.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 6 && COMPLETE_SHORT_COMMAND_RE.test(clean)) {
    return 750;
  }

  if (wordCount <= 4) {
    return 950;
  }

  return 1150;
}

export interface BargeInGateConfig {
  attackGuardMs?: number;
  minBargeInRms?: number;
  noiseMultiplier?: number;
  minSustainedMs?: number;
}

/**
 * Echo-resistant acoustic barge-in detector active while SETH is speaking TTS.
 * Requires sustained speech energy well above the calibrated floor after the TTS onset guard,
 * and auto-tightens its margin if repeated empty self-triggers occur (speaker bleed protection).
 */
export class BargeInGate {
  private readonly attackGuardMs: number;
  private readonly minBargeInRms: number;
  private readonly noiseMultiplier: number;
  private readonly minSustainedMs: number;

  private active = false;
  private ttsStartedAt = 0;
  private sustainedMs = 0;
  private emptyTriggerStreak = 0;

  constructor(config: BargeInGateConfig = {}) {
    this.attackGuardMs = config.attackGuardMs ?? 250;
    this.minBargeInRms = config.minBargeInRms ?? 0.032;
    this.noiseMultiplier = config.noiseMultiplier ?? 4.0;
    this.minSustainedMs = config.minSustainedMs ?? 220;
  }

  public arm(nowMs: number = Date.now()): void {
    this.active = true;
    this.ttsStartedAt = nowMs;
    this.sustainedMs = 0;
  }

  public disarm(): void {
    this.active = false;
    this.sustainedMs = 0;
  }

  public isArmed(): boolean {
    return this.active;
  }

  public recordEmptyBargeIn(): void {
    this.emptyTriggerStreak = Math.min(4, this.emptyTriggerStreak + 1);
  }

  public recordValidBargeIn(): void {
    this.emptyTriggerStreak = 0;
  }

  public getEffectiveMarginMultiplier(): number {
    return Math.min(2.2, 1 + this.emptyTriggerStreak * 0.4);
  }

  public evaluateFrame(
    rms: number,
    frameDurationMs: number,
    noiseFloorRms: number,
    nowMs: number = Date.now()
  ): boolean {
    if (!this.active) return false;
    if (nowMs - this.ttsStartedAt < this.attackGuardMs) {
      this.sustainedMs = 0;
      return false;
    }

    const margin = this.getEffectiveMarginMultiplier();
    const threshold = Math.max(
      this.minBargeInRms * margin,
      noiseFloorRms * this.noiseMultiplier * margin
    );

    if (rms >= threshold) {
      this.sustainedMs += frameDurationMs;
      if (this.sustainedMs >= this.minSustainedMs) {
        this.active = false;
        this.sustainedMs = 0;
        return true;
      }
    } else {
      this.sustainedMs = Math.max(0, this.sustainedMs - frameDurationMs * 0.5);
    }

    return false;
  }
}
