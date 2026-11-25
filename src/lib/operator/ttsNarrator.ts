// Kite Code — TTS Narrator
// Speech synthesis engine for reading agent outputs, terminal summaries, and operator feedback aloud.
// Supports:
//  1. High-fidelity Neural Streaming via ElevenLabs (eleven_v4_turbo / eleven_flash_v2_5) with zero-latency abort.
//  2. Native Web Speech API fallback with smart speech-cleaning filters, persona voice modulation,
//     and natural neural voice prioritization.
import { sanitizeReply } from './planner/sanitize';
import { loadOperatorConfig, syncNativeCredentialsWithVault } from './operatorConfig';
import { normalizeForVoiceSpeech, SpeechSentenceQueue } from './voice/speechProsody';
import { emitTrace } from './trace/trace';
import { runLedger } from './runLedger';

export interface TTSOptions {
  lang?: string; // Default: 'es-ES' or 'en-US'
  rate?: number; // 0.8 - 1.5, default: 1.0
  pitch?: number; // 0.8 - 1.2, default: 1.0
  volume?: number; // 0 - 1.0, default: 1.0
  voiceName?: string; // Persona name ('Ara', 'Rex', 'Eve', 'Leo', 'Sal') or exact system voice name
  engine?: 'browser' | 'elevenlabs';
  elevenlabsApiKey?: string;
  elevenlabsModel?: string;
  elevenlabsVoiceId?: string;
  elevenlabsStability?: number;
  elevenlabsSimilarity?: number;
  /** Optional turnId for emitting `tts.first_audio` latency traces. */
  turnId?: string;
  /** Optional turn start / STT finalized timestamp used to calculate TTFA (`ttfaMs`). */
  turnStartedAt?: number;
  /** Optional STT finalization timestamp (`t = 0`) for Voice SLI reporting. */
  sttFinalizedAt?: number;
  onStart?: () => void;
  onFirstAudio?: () => void;
  onEnd?: () => void;
  onError?: (err: any) => void;
}

export interface PersonaVoiceProfile {
  gender: 'female' | 'male' | 'neutral';
  pitchMultiplier: number;
  rateMultiplier: number;
  preferredKeywords: string[];
}

export const PERSONA_VOICE_PROFILES: Record<string, PersonaVoiceProfile> = {
  Ara: {
    gender: 'female',
    pitchMultiplier: 1.05,
    rateMultiplier: 1.02,
    preferredKeywords: ['dalia', 'salome', 'sabina', 'helena', 'monica', 'paulina', 'lucia', 'laura', 'maria', 'elena', 'female'],
  },
  Rex: {
    gender: 'male',
    pitchMultiplier: 0.93,
    rateMultiplier: 1.00,
    preferredKeywords: ['jorge', 'alvaro', 'raul', 'pablo', 'david', 'enrique', 'diego', 'carlos', 'male'],
  },
  Eve: {
    gender: 'female',
    pitchMultiplier: 0.98,
    rateMultiplier: 0.94,
    preferredKeywords: ['helena', 'dalia', 'salome', 'sabina', 'monica', 'female'],
  },
  Leo: {
    gender: 'male',
    pitchMultiplier: 0.88,
    rateMultiplier: 1.06,
    preferredKeywords: ['alvaro', 'jorge', 'raul', 'david', 'enrique', 'male'],
  },
  Sal: {
    gender: 'neutral',
    pitchMultiplier: 1.00,
    rateMultiplier: 1.00,
    preferredKeywords: ['natural', 'neural', 'online', 'google'],
  },
};

/**
 * Strips code blocks, markdown symbols, UUIDs, file paths, URLs, CLI flags,
 * template clichés, and noisy syntax so text reads naturally aloud.
 */
export function cleanTextForSpeech(text: string): string {
  return normalizeForVoiceSpeech(text);
}

/**
 * Returns available system synthesis voices, asynchronously awaiting onvoiceschanged if needed.
 */
export function getAvailableVoices(): Promise<SpeechSynthesisVoice[]> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return Promise.resolve([]);
  }

  const immediate = window.speechSynthesis.getVoices();
  if (immediate && immediate.length > 0) {
    return Promise.resolve(immediate);
  }

  return new Promise((resolve) => {
    let resolved = false;
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      try {
        window.speechSynthesis.removeEventListener('voiceschanged', onVoices);
      } catch {}
      resolve(window.speechSynthesis.getVoices() || []);
    };

    const onVoices = () => cleanup();

    try {
      window.speechSynthesis.addEventListener('voiceschanged', onVoices);
    } catch {}

    setTimeout(cleanup, 400);
  });
}

/**
 * Selects the optimal SpeechSynthesisVoice given a preferred voice name/persona and language.
 */
export function resolveBestVoice(
  voices: SpeechSynthesisVoice[],
  voiceName?: string,
  targetLang: string = 'es-ES'
): SpeechSynthesisVoice | null {
  if (!voices || voices.length === 0) return null;

  const targetPrefix = targetLang.slice(0, 2).toLowerCase();

  // 1. Direct match with installed system voice name (exact or case-insensitive)
  if (voiceName) {
    const directMatch = voices.find(
      (v) => v.name.toLowerCase() === voiceName.toLowerCase()
    );
    if (directMatch) return directMatch;
  }

  // 2. Persona matching (Ara, Rex, Eve, Leo, Sal)
  const profileKey = Object.keys(PERSONA_VOICE_PROFILES).find(
    (k) => k.toLowerCase() === (voiceName || 'Ara').toLowerCase()
  );
  const profile = profileKey ? PERSONA_VOICE_PROFILES[profileKey] : PERSONA_VOICE_PROFILES.Ara;

  // Filter candidate voices in target language first
  const langVoices = voices.filter((v) => v.lang.toLowerCase().startsWith(targetPrefix));
  const candidatePool = langVoices.length > 0 ? langVoices : voices;

  // Rank candidate voices
  let bestVoice: SpeechSynthesisVoice | null = null;
  let highestScore = -1;

  for (const v of candidatePool) {
    const vNameLower = v.name.toLowerCase();
    let score = 0;

    const isNatural =
      vNameLower.includes('natural') ||
      vNameLower.includes('neural') ||
      vNameLower.includes('online') ||
      vNameLower.includes('google') ||
      vNameLower.includes('enhanced') ||
      vNameLower.includes('premium');

    // Natural/neural voices get significant boost to avoid robotic legacy SAPI
    if (isNatural) score += 10;

    // Matches persona preferred keyword (e.g. name or gender indicator)
    const matchesKeyword = profile.preferredKeywords.some((kw) => vNameLower.includes(kw));
    if (matchesKeyword) score += 6;

    // Prefer exact language match over generic language prefix
    if (v.lang.toLowerCase() === targetLang.toLowerCase()) score += 2;

    // Deprioritize ancient SAPI 16kHz desktop voices if alternatives exist
    if (vNameLower.includes('desktop')) score -= 3;

    if (score > highestScore) {
      highestScore = score;
      bestVoice = v;
    }
  }

  return bestVoice || candidatePool[0] || null;
}

export function splitIntoSpeechSentences(text: string): string[] {
  const sentences = text.match(/[^.!?;\n\r]+[.!?;\n\r]+|[^.!?;\n\r]+$/g);
  if (!sentences) return [text];
  const chunks: string[] = [];
  for (const raw of sentences) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.length > 160) {
      const subParts = trimmed.match(/[^,]+,+|[^,]+$/g);
      if (subParts && subParts.length > 1) {
        for (const sp of subParts) {
          const t = sp.trim();
          if (t) chunks.push(t);
        }
        continue;
      }
    }
    chunks.push(trimmed);
  }
  return chunks.length > 0 ? chunks : [text];
}

export interface InterruptedPlaybackInfo {
  playedText: string;
  audioEndMs: number;
}

export function estimateSpeechDurationMs(text: string, rate: number = 1.0): number {
  const clean = (text || '').trim();
  if (!clean) return 0;
  const safeRate = Number.isFinite(rate) && rate > 0 ? Math.min(2.0, Math.max(0.5, rate)) : 1.0;
  // ~14.5 characters per second at 1.0x natural speaking cadence
  return Math.max(350, Math.round((clean.length / (14.5 * safeRate)) * 1000));
}

/**
 * Truncates `text` to the portion proportionally heard in `heardMs` out of `durationMs`,
 * snapping cleanly at a word boundary so partial words are never emitted.
 */
export function truncateTextToHeardMs(
  text: string,
  heardMs: number,
  durationMs?: number
): string {
  const clean = (text || '').trim();
  if (!clean) return '';
  if (!Number.isFinite(heardMs) || heardMs <= 0) return '';

  const totalMs =
    typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
      ? durationMs
      : estimateSpeechDurationMs(clean);
  if (totalMs <= 0) return '';

  const ratio = Math.min(1, Math.max(0, heardMs / totalMs));
  if (ratio >= 1) return clean;

  const targetChars = Math.floor(clean.length * ratio);
  if (targetChars <= 0) return '';
  if (targetChars >= clean.length) return clean;

  if (/\s/.test(clean[targetChars])) {
    return clean.slice(0, targetChars).trim();
  }

  const prefix = clean.slice(0, targetChars);
  const lastSpaceMatch = /\s(?=\S*$)/.exec(prefix);
  if (lastSpaceMatch && lastSpaceMatch.index > 0) {
    return prefix.slice(0, lastSpaceMatch.index).trim();
  }

  if (!/\s/.test(clean) && ratio >= 0.5) {
    return clean;
  }

  return '';
}

class TTSNarrator {
  private speaking = false;
  private activeUtterance: SpeechSynthesisUtterance | null = null;
  private activeAudio: HTMLAudioElement | null = null;
  private activeAudioUrl: string | null = null;
  private activeAudioContext: AudioContext | null = null;
  private activeGainNode: GainNode | null = null;
  private activeAbortController: AbortController | null = null;
  private activeInterruptResolvers = new Set<() => void>();
  private rampStepInterval: ReturnType<typeof setInterval> | null = null;
  private rampFinishTimer: ReturnType<typeof setTimeout> | null = null;
  private rampingAudio: HTMLAudioElement | null = null;
  private rampingAudioUrl: string | null = null;
  private rampingAudioContext: AudioContext | null = null;
  private rampingGainNode: GainNode | null = null;
  private safetyTimer: any = null;
  private keepAliveInterval: any = null;
  private generation = 0;

  // Heard-audio tracking for exact barge-in truncation
  private activeSpokenText = '';
  private spokenSentenceStartMs = 0;
  private estimatedTotalDurationMs = 0;
  private playedSentences: string[] = [];
  private completedAudioDurationMs = 0;
  private lastInterruptedPrefix = '';
  private lastAudioEndMs = 0;
  private hasInterruptedPlayback = false;

  public isAvailable(): boolean {
    if (typeof window === 'undefined') return false;
    return 'speechSynthesis' in window || typeof Audio !== 'undefined';
  }

  public isSpeaking(): boolean {
    if (this.speaking) return true;
    if (this.activeAudio && !this.activeAudio.paused && !this.activeAudio.ended) return true;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      return window.speechSynthesis.speaking || Boolean(this.activeUtterance);
    }
    return false;
  }

  public async getAvailableVoices(): Promise<SpeechSynthesisVoice[]> {
    return getAvailableVoices();
  }

  public getLastInterruptedPlayback(): InterruptedPlaybackInfo | null {
    if (!this.hasInterruptedPlayback) return null;
    return {
      playedText: this.lastInterruptedPrefix,
      audioEndMs: this.lastAudioEndMs,
    };
  }

  private beginUtteranceTracking(text: string, rate: number = 1.0): void {
    this.activeSpokenText = text.trim();
    this.spokenSentenceStartMs = 0;
    this.estimatedTotalDurationMs = estimateSpeechDurationMs(this.activeSpokenText, rate);
  }

  private markUtterancePlaybackStarted(): void {
    if (!this.spokenSentenceStartMs) {
      this.spokenSentenceStartMs = Date.now();
    }
  }

  private markUtteranceCompleted(text: string): void {
    const clean = text.trim();
    if (clean) {
      this.playedSentences.push(clean);
    }
    const audioCurrentMs =
      this.activeAudio &&
      Number.isFinite(this.activeAudio.currentTime) &&
      this.activeAudio.currentTime > 0
        ? this.activeAudio.currentTime * 1000
        : 0;
    const elapsedMs =
      audioCurrentMs > 0
        ? audioCurrentMs
        : this.spokenSentenceStartMs > 0
          ? Math.max(0, Date.now() - this.spokenSentenceStartMs)
          : this.estimatedTotalDurationMs;
    this.completedAudioDurationMs += Math.max(0, Math.round(elapsedMs));
    this.activeSpokenText = '';
    this.spokenSentenceStartMs = 0;
    this.estimatedTotalDurationMs = 0;
  }

  private resetTurnPlaybackState(clearInterruptedRecord: boolean): void {
    this.activeSpokenText = '';
    this.spokenSentenceStartMs = 0;
    this.estimatedTotalDurationMs = 0;
    this.playedSentences = [];
    this.completedAudioDurationMs = 0;
    if (clearInterruptedRecord) {
      this.lastInterruptedPrefix = '';
      this.lastAudioEndMs = 0;
      this.hasInterruptedPlayback = false;
    }
  }

  private captureInterruptedPlayback(): InterruptedPlaybackInfo {
    const hasTurnContent =
      Boolean(this.activeSpokenText) || this.playedSentences.length > 0;
    if (!hasTurnContent) {
      return this.hasInterruptedPlayback
        ? { playedText: this.lastInterruptedPrefix, audioEndMs: this.lastAudioEndMs }
        : { playedText: '', audioEndMs: 0 };
    }

    const audioCurrentMs =
      this.activeAudio &&
      Number.isFinite(this.activeAudio.currentTime) &&
      this.activeAudio.currentTime > 0
        ? this.activeAudio.currentTime * 1000
        : 0;
    const activeHeardMs =
      audioCurrentMs > 0
        ? Math.round(audioCurrentMs)
        : this.spokenSentenceStartMs > 0
          ? Math.max(0, Date.now() - this.spokenSentenceStartMs)
          : 0;

    const audioDurationMs =
      this.activeAudio &&
      Number.isFinite(this.activeAudio.duration) &&
      this.activeAudio.duration > 0
        ? this.activeAudio.duration * 1000
        : 0;
    const totalEstimatedMs =
      audioDurationMs > 0 ? audioDurationMs : this.estimatedTotalDurationMs;

    const activePrefix =
      this.activeSpokenText && activeHeardMs > 0
        ? truncateTextToHeardMs(this.activeSpokenText, activeHeardMs, totalEstimatedMs)
        : '';

    const combinedParts = [...this.playedSentences];
    if (activePrefix) {
      combinedParts.push(activePrefix);
    }

    const playedText = combinedParts.join(' ').trim();
    const audioEndMs = Math.max(0, this.completedAudioDurationMs + activeHeardMs);

    this.lastInterruptedPrefix = playedText;
    this.lastAudioEndMs = audioEndMs;
    this.hasInterruptedPlayback = true;
    this.resetTurnPlaybackState(false);

    return { playedText, audioEndMs };
  }

  private detachAudioGain(): void {
    if (this.activeGainNode) {
      try {
        this.activeGainNode.disconnect();
      } catch {}
      this.activeGainNode = null;
    }
    if (this.activeAudioContext) {
      try {
        void this.activeAudioContext.close();
      } catch {}
      this.activeAudioContext = null;
    }
  }

  private attachAudioGain(audio: HTMLAudioElement, volume: number): void {
    this.detachAudioGain();
    if (typeof window === 'undefined') return;
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (typeof AudioCtx !== 'function') return;
    try {
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') {
        try {
          void ctx.close();
        } catch {}
        return;
      }
      if (
        typeof ctx.createMediaElementSource !== 'function' ||
        typeof ctx.createGain !== 'function'
      ) {
        try {
          void ctx.close();
        } catch {}
        return;
      }
      const source = ctx.createMediaElementSource(audio);
      const gain = ctx.createGain();
      gain.gain.value = volume;
      source.connect(gain);
      gain.connect(ctx.destination);
      this.activeAudioContext = ctx;
      this.activeGainNode = gain;
    } catch {
      this.detachAudioGain();
    }
  }

  private finalizeRampingAudio(): void {
    if (this.rampStepInterval) {
      clearInterval(this.rampStepInterval);
      this.rampStepInterval = null;
    }
    if (this.rampFinishTimer) {
      clearTimeout(this.rampFinishTimer);
      this.rampFinishTimer = null;
    }
    if (this.rampingAudio) {
      try {
        this.rampingAudio.pause();
        this.rampingAudio.currentTime = 0;
        this.rampingAudio.src = '';
      } catch {}
      this.rampingAudio = null;
    }
    if (this.rampingAudioUrl) {
      try {
        URL.revokeObjectURL(this.rampingAudioUrl);
      } catch {}
      this.rampingAudioUrl = null;
    }
    if (this.rampingGainNode) {
      try {
        this.rampingGainNode.disconnect();
      } catch {}
      this.rampingGainNode = null;
    }
    if (this.rampingAudioContext) {
      try {
        void this.rampingAudioContext.close();
      } catch {}
      this.rampingAudioContext = null;
    }
  }

  private resolveActiveInterrupts(): void {
    if (this.activeInterruptResolvers.size === 0) return;
    const resolvers = Array.from(this.activeInterruptResolvers);
    this.activeInterruptResolvers.clear();
    for (const resolve of resolvers) {
      try {
        resolve();
      } catch {}
    }
  }

  public stop(): void {
    this.generation++;
    this.captureInterruptedPlayback();
    this.finalizeRampingAudio();
    this.detachAudioGain();
    if (this.activeAbortController) {
      try {
        this.activeAbortController.abort();
      } catch {}
      this.activeAbortController = null;
    }
    if (this.activeAudio) {
      try {
        this.activeAudio.pause();
        this.activeAudio.currentTime = 0;
        this.activeAudio.src = '';
      } catch {}
      this.activeAudio = null;
    }
    if (this.activeAudioUrl) {
      try {
        URL.revokeObjectURL(this.activeAudioUrl);
      } catch {}
      this.activeAudioUrl = null;
    }
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
    this.speaking = false;
    this.activeUtterance = null;
    this.resolveActiveInterrupts();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
  }

  /**
   * Interrupts TTS playback immediately logically, applying a smooth `rampMs` (default 20ms)
   * volume/gain fade-out on active audio before pausing, and returns the exact heard prefix
   * (`playedText`) and elapsed audio timestamp (`audioEndMs`).
   */
  public stopWithRamp(rampMs: number = 20): InterruptedPlaybackInfo {
    this.generation++;
    const info = this.captureInterruptedPlayback();
    this.finalizeRampingAudio();

    if (this.activeAbortController) {
      try {
        this.activeAbortController.abort();
      } catch {}
      this.activeAbortController = null;
    }
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
    this.speaking = false;
    this.activeUtterance = null;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }

    const audio = this.activeAudio;
    const audioUrl = this.activeAudioUrl;
    const gainNode = this.activeGainNode;
    const audioCtx = this.activeAudioContext;
    this.activeAudio = null;
    this.activeAudioUrl = null;
    this.activeGainNode = null;
    this.activeAudioContext = null;
    this.resolveActiveInterrupts();

    if (audio && rampMs > 0) {
      const safeRampMs = Math.max(4, Math.min(200, Math.round(rampMs)));
      this.rampingAudio = audio;
      this.rampingAudioUrl = audioUrl;
      this.rampingGainNode = gainNode;
      this.rampingAudioContext = audioCtx;

      if (gainNode && audioCtx) {
        try {
          const now = audioCtx.currentTime ?? 0;
          const gainParam = gainNode.gain;
          if (typeof gainParam.setValueAtTime === 'function') {
            gainParam.setValueAtTime(gainParam.value ?? 1, now);
          }
          if (typeof gainParam.linearRampToValueAtTime === 'function') {
            gainParam.linearRampToValueAtTime(0, now + safeRampMs / 1000);
          } else {
            gainParam.value = 0;
          }
        } catch {}
      }

      const startVolume = typeof audio.volume === 'number' ? Math.max(0, Math.min(1, audio.volume)) : 1;
      const steps = 4;
      const stepMs = Math.max(1, Math.floor(safeRampMs / steps));
      let stepIndex = 0;
      this.rampStepInterval = setInterval(() => {
        stepIndex += 1;
        const ratio = Math.max(0, 1 - stepIndex / steps);
        try {
          audio.volume = startVolume * ratio;
        } catch {}
        if (stepIndex >= steps && this.rampStepInterval) {
          clearInterval(this.rampStepInterval);
          this.rampStepInterval = null;
        }
      }, stepMs);

      this.rampFinishTimer = setTimeout(() => {
        this.finalizeRampingAudio();
      }, safeRampMs);
    } else {
      if (audio) {
        try {
          audio.pause();
          audio.currentTime = 0;
          audio.src = '';
        } catch {}
      }
      if (audioUrl) {
        try {
          URL.revokeObjectURL(audioUrl);
        } catch {}
      }
      this.detachAudioGain();
    }

    return info;
  }

  public pause(): void {
    if (this.activeAudio) {
      try {
        this.activeAudio.pause();
      } catch {}
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.pause();
      } catch {}
    }
  }

  public resume(): void {
    if (this.activeAudio) {
      try {
        this.activeAudio.play();
      } catch {}
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.resume();
      } catch {}
    }
  }

  public createStreamingQueue(optionsOrLang: TTSOptions | string = {}): SpeechSentenceQueue {
    const options: TTSOptions =
      typeof optionsOrLang === 'string' ? { lang: optionsOrLang } : optionsOrLang;
    // Reset any prior audio once at the start of the streaming utterance
    this.stop();
    this.resetTurnPlaybackState(true);
    const streamGen = this.generation;
    let firstNotified = false;

    return new SpeechSentenceQueue({
      onFirstSentence: () => {
        if (!firstNotified) {
          firstNotified = true;
          options.onStart?.();
        }
      },
      speakSentence: async (sentence, index) => {
        if (this.generation !== streamGen) return;
        await this.speakSentenceWithoutReset(sentence, {
          ...options,
          onStart: index === 0 && !firstNotified ? options.onStart : undefined,
          onEnd: undefined,
        }, streamGen);
      },
      onComplete: () => {
        if (this.generation === streamGen) {
          this.resetTurnPlaybackState(true);
          options.onEnd?.();
        }
      },
      onError: options.onError,
    });
  }

  private async speakSentenceWithoutReset(
    text: string,
    options: TTSOptions,
    myGen: number
  ): Promise<void> {
    if (this.generation !== myGen) return;
    const sanitized = sanitizeReply(text, '', 2000);
    const textToSpeak = cleanTextForSpeech(sanitized);
    if (!textToSpeak) return;

    let config: any = null;
    try {
      config = loadOperatorConfig();
    } catch {}

    const engine = options.engine || config?.ttsEngine || 'browser';
    const apiKey = (options.elevenlabsApiKey || config?.elevenlabsApiKey || '').trim();
    if (engine === 'elevenlabs' && apiKey.length > 0) {
      try {
        await this.speakElevenLabs(textToSpeak, { ...options, onError: undefined }, config, myGen);
        return;
      } catch (err: any) {
        if (this.generation !== myGen || err?.name === 'AbortError' || err?.code === 20) {
          return;
        }
      }
    }

    if (this.generation !== myGen) return;
    return this.speakBrowser(textToSpeak, options, myGen);
  }

  public async speak(text: string, optionsOrLang: TTSOptions | string = {}): Promise<void> {
    const options: TTSOptions =
      typeof optionsOrLang === 'string' ? { lang: optionsOrLang } : optionsOrLang;

    // Cancel any previous speech and record generation
    this.stop();
    this.resetTurnPlaybackState(true);
    const myGen = this.generation;

    // Sanitize to prevent prompt echo, code fences or noise from reaching TTS
    const sanitized = sanitizeReply(text, '', 2000);
    const textToSpeak = cleanTextForSpeech(sanitized);
    if (!textToSpeak) return;

    let config: any = null;
    try {
      config = loadOperatorConfig();
    } catch {}

    let engine = options.engine || config?.ttsEngine || 'browser';
    let apiKey = (options.elevenlabsApiKey || config?.elevenlabsApiKey || '').trim();
    if (engine === 'elevenlabs' && !apiKey) {
      try {
        config = await syncNativeCredentialsWithVault();
        apiKey = (options.elevenlabsApiKey || config?.elevenlabsApiKey || '').trim();
      } catch {}
    }

    if (engine === 'elevenlabs' && apiKey.length > 0) {
      try {
        // Suppress caller onError during ElevenLabs attempt so playback/stream failures
        // fall back cleanly to speakBrowser without prematurely re-arming the mic or calling stop().
        await this.speakElevenLabs(textToSpeak, { ...options, onError: undefined }, config, myGen);
        if (this.generation === myGen) {
          this.resetTurnPlaybackState(true);
        }
        return;
      } catch (err: any) {
        // If interrupted, stopped by user, or superseded, NEVER fall back to local voice!
        if (
          this.generation !== myGen ||
          err?.name === 'AbortError' ||
          err?.code === 20 ||
          (typeof err?.message === 'string' &&
            (err.message.includes('interrupted') ||
              err.message.includes('abort') ||
              err.message.includes('pause')))
        ) {
          return;
        }
        console.warn(
          '[TTSNarrator] Error en ElevenLabs TTS streaming, activando fallback a voz nativa:',
          err
        );
      }
    }

    // Never fall back to browser voice if user requested to stop or interrupt
    if (this.generation !== myGen) {
      return;
    }

    await this.speakBrowser(textToSpeak, options, myGen);
    if (this.generation === myGen) {
      this.resetTurnPlaybackState(true);
    }
  }

  private async speakElevenLabs(
    textToSpeak: string,
    options: TTSOptions,
    config: any,
    myGen: number
  ): Promise<void> {
    if (this.generation !== myGen) return;

    const apiKey = (options.elevenlabsApiKey || config?.elevenlabsApiKey || '').trim();
    const voiceId = options.elevenlabsVoiceId || config?.elevenlabsVoiceId || '21m00Tcm4TlvDq8ikWAM';
    const model = options.elevenlabsModel || config?.elevenlabsModel || 'eleven_v4_turbo';
    const stability = options.elevenlabsStability ?? config?.elevenlabsStability ?? 0.5;
    const similarity = options.elevenlabsSimilarity ?? config?.elevenlabsSimilarity ?? 0.8;
    const speed = options.rate ?? config?.ttsRate ?? 1.0;

    this.beginUtteranceTracking(textToSpeak, speed);

    const controller = new AbortController();
    this.activeAbortController = controller;

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      voiceId
    )}/stream?output_format=mp3_44100_128&optimize_streaming_latency=3`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text: textToSpeak,
        model_id: model,
        voice_settings: {
          stability,
          similarity_boost: similarity,
          speed,
        },
      }),
      signal: controller.signal,
    });

    if (this.generation !== myGen || controller.signal.aborted) return;

    if (!res.ok) {
      throw new Error(`ElevenLabs API devolvió HTTP ${res.status}: ${res.statusText}`);
    }

    const canStream =
      typeof MediaSource !== 'undefined' &&
      typeof MediaSource.isTypeSupported === 'function' &&
      MediaSource.isTypeSupported('audio/mpeg') &&
      Boolean(res.body && typeof res.body.getReader === 'function');

    if (canStream && res.body) {
      return new Promise<void>((resolve, reject) => {
        const mediaSource = new MediaSource();
        const audioUrl = URL.createObjectURL(mediaSource);
        this.activeAudioUrl = audioUrl;
        const audio = new Audio(audioUrl);
        this.activeAudio = audio;
        audio.volume = options.volume ?? 1.0;
        this.attachAudioGain(audio, audio.volume);

        let finished = false;
        let onInterruptResolve: (() => void) | null = null;
        const cleanup = () => {
          if (finished) return;
          finished = true;
          this.speaking = false;
          if (onInterruptResolve) {
            this.activeInterruptResolvers.delete(onInterruptResolve);
            onInterruptResolve = null;
          }
          if (this.activeAudio === audio) {
            this.activeAudio = null;
            this.detachAudioGain();
          }
          if (this.activeAudioUrl === audioUrl) {
            try {
              URL.revokeObjectURL(audioUrl);
            } catch {}
            this.activeAudioUrl = null;
          }
          if (this.activeAbortController === controller) {
            this.activeAbortController = null;
          }
        };

        onInterruptResolve = () => {
          cleanup();
          resolve();
        };
        this.activeInterruptResolvers.add(onInterruptResolve);

        audio.onplay = () => {
          if (this.generation !== myGen || controller.signal.aborted) {
            cleanup();
            try {
              audio.pause();
            } catch {}
            resolve();
            return;
          }
          this.speaking = true;
          this.markUtterancePlaybackStarted();
          const firstAudioTs = Date.now();
          options.onFirstAudio?.();
          if (options.turnId) {
            try {
              const t0 = options.sttFinalizedAt ?? options.turnStartedAt;
              runLedger.recordVoiceClassification(options.turnId, {
                ttsEngine: 'elevenlabs_http',
              });
              runLedger.recordVoiceMilestones(options.turnId, {
                firstAudioAt: firstAudioTs,
              });
              emitTrace({
                turnId: options.turnId,
                ev: 'tts.first_audio',
                engine: 'elevenlabs_http',
                firstAudioAt: firstAudioTs,
                ttfaMs: t0 ? Math.max(0, firstAudioTs - t0) : undefined,
              });
            } catch {}
          }
          options.onStart?.();
        };

        audio.onended = () => {
          if (this.generation === myGen) {
            this.markUtteranceCompleted(textToSpeak);
          }
          cleanup();
          options.onEnd?.();
          resolve();
        };

        audio.onerror = (e) => {
          cleanup();
          if (this.generation !== myGen || controller.signal.aborted) {
            resolve();
            return;
          }
          reject(e);
        };

        mediaSource.addEventListener('sourceopen', async () => {
          if (this.generation !== myGen || controller.signal.aborted) {
            cleanup();
            resolve();
            return;
          }

          let sourceBuffer: SourceBuffer;
          try {
            sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
          } catch (sbErr) {
            cleanup();
            reject(
              sbErr instanceof Error ? sbErr : new Error('MediaSource addSourceBuffer failed')
            );
            return;
          }

          const reader = res.body!.getReader();
          let startedPlayback = false;
          const queue: Uint8Array[] = [];
          let isAppending = false;
          let readerDone = false;

          const pump = () => {
            if (isAppending || queue.length === 0 || !sourceBuffer || mediaSource.readyState !== 'open') return;
            const chunk = queue.shift()!;
            try {
              isAppending = true;
              sourceBuffer.appendBuffer(chunk as unknown as BufferSource);
            } catch {
              isAppending = false;
            }
          };

          sourceBuffer.addEventListener('updateend', () => {
            isAppending = false;
            if (!startedPlayback && audio.paused) {
              startedPlayback = true;
              void audio.play().catch((playErr) => {
                if (this.generation === myGen && !controller.signal.aborted) {
                  cleanup();
                  reject(playErr);
                }
              });
            }
            if (queue.length > 0) {
              pump();
            } else if (readerDone && mediaSource.readyState === 'open') {
              try {
                mediaSource.endOfStream();
              } catch {}
            }
          });

          try {
            while (true) {
              if (finished || this.generation !== myGen || controller.signal.aborted) {
                try {
                  void reader.cancel();
                } catch {}
                cleanup();
                resolve();
                return;
              }
              const { done, value } = await reader.read();
              if (done) {
                readerDone = true;
                if (!isAppending && queue.length === 0 && mediaSource.readyState === 'open') {
                  try {
                    mediaSource.endOfStream();
                  } catch {}
                }
                break;
              }
              if (value && value.length > 0) {
                queue.push(value);
                pump();
              }
            }
          } catch (readErr) {
            if (this.generation === myGen && !controller.signal.aborted) {
              cleanup();
              reject(readErr);
            }
          }
        });
      });
    }

    const blob = await res.blob();
    if (this.generation !== myGen || controller.signal.aborted) return;

    if (typeof Audio === 'undefined') {
      options.onStart?.();
      options.onEnd?.();
      return;
    }

    return new Promise<void>((resolve, reject) => {
      if (this.generation !== myGen || controller.signal.aborted) {
        resolve();
        return;
      }

      const audioUrl = URL.createObjectURL(blob);
      this.activeAudioUrl = audioUrl;
      const audio = new Audio(audioUrl);
      this.activeAudio = audio;
      audio.volume = options.volume ?? 1.0;
      this.attachAudioGain(audio, audio.volume);

      let finished = false;
      let onInterruptResolve: (() => void) | null = null;
      const cleanup = () => {
        if (finished) return;
        finished = true;
        this.speaking = false;
        if (onInterruptResolve) {
          this.activeInterruptResolvers.delete(onInterruptResolve);
          onInterruptResolve = null;
        }
        if (this.activeAudio === audio) {
          this.activeAudio = null;
          this.detachAudioGain();
        }
        if (this.activeAudioUrl === audioUrl) {
          try {
            URL.revokeObjectURL(audioUrl);
          } catch {}
          this.activeAudioUrl = null;
        }
        if (this.activeAbortController === controller) {
          this.activeAbortController = null;
        }
      };

      onInterruptResolve = () => {
        cleanup();
        resolve();
      };
      this.activeInterruptResolvers.add(onInterruptResolve);

      audio.onplay = () => {
        if (this.generation !== myGen || controller.signal.aborted) {
          cleanup();
          try {
            audio.pause();
          } catch {}
          resolve();
          return;
        }
        this.speaking = true;
        this.markUtterancePlaybackStarted();
        const firstAudioTs = Date.now();
        options.onFirstAudio?.();
        if (options.turnId) {
          try {
            const t0 = options.sttFinalizedAt ?? options.turnStartedAt;
            runLedger.recordVoiceClassification(options.turnId, {
              ttsEngine: 'elevenlabs_http',
            });
            runLedger.recordVoiceMilestones(options.turnId, {
              firstAudioAt: firstAudioTs,
            });
            emitTrace({
              turnId: options.turnId,
              ev: 'tts.first_audio',
              engine: 'elevenlabs_http',
              firstAudioAt: firstAudioTs,
              ttfaMs: t0 ? Math.max(0, firstAudioTs - t0) : undefined,
            });
          } catch {}
        }
        options.onStart?.();
      };

      audio.onended = () => {
        if (this.generation === myGen) {
          this.markUtteranceCompleted(textToSpeak);
        }
        cleanup();
        options.onEnd?.();
        resolve();
      };

      audio.onerror = (e) => {
        cleanup();
        // If interrupted or stopped by user, resolve silently without triggering browser fallback
        if (this.generation !== myGen || controller.signal.aborted) {
          resolve();
          return;
        }
        reject(e);
      };

      audio.play().catch((playErr) => {
        cleanup();
        // If interrupted or stopped by user, resolve silently without triggering browser fallback
        if (this.generation !== myGen || controller.signal.aborted) {
          resolve();
          return;
        }
        reject(playErr);
      });
    });
  }

  private async speakBrowser(
    textToSpeak: string,
    options: TTSOptions,
    myGen?: number
  ): Promise<void> {
    if (myGen !== undefined && this.generation !== myGen) return;

    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      options.onError?.(new Error('SpeechSynthesis no disponible en este entorno'));
      return;
    }

    const voices = await getAvailableVoices();
    if (myGen !== undefined && this.generation !== myGen) return;

    const chunks = splitIntoSpeechSentences(textToSpeak);

    const lang =
      options.lang ||
      (/[áéíóúñ¿¡]|\b(el|la|los|las|de|en|y|o|para|con)\b/i.test(textToSpeak)
        ? 'es-ES'
        : 'en-US');

    const selectedVoice = resolveBestVoice(voices, options.voiceName, lang);

    const profileKey = Object.keys(PERSONA_VOICE_PROFILES).find(
      (k) => k.toLowerCase() === (options.voiceName || 'Ara').toLowerCase()
    );
    const profile = profileKey ? PERSONA_VOICE_PROFILES[profileKey] : PERSONA_VOICE_PROFILES.Ara;

    const baseRate = options.rate ?? 1.0;
    const basePitch = options.pitch ?? 1.0;

    const tunedRate = Math.min(1.45, Math.max(0.75, baseRate * profile.rateMultiplier));
    const tunedPitch = Math.min(1.3, Math.max(0.8, basePitch * profile.pitchMultiplier));

    return new Promise<void>((resolve) => {
      let chunkIdx = 0;
      let hasStarted = false;
      let isDone = false;
      let onInterruptResolve: (() => void) | null = null;

      const finishAll = () => {
        if (isDone) return;
        isDone = true;
        if (onInterruptResolve) {
          this.activeInterruptResolvers.delete(onInterruptResolve);
          onInterruptResolve = null;
        }
        if (this.keepAliveInterval) {
          clearInterval(this.keepAliveInterval);
          this.keepAliveInterval = null;
        }
        if (this.safetyTimer) {
          clearTimeout(this.safetyTimer);
          this.safetyTimer = null;
        }
        this.speaking = false;
        this.activeUtterance = null;
        resolve();
      };

      onInterruptResolve = () => finishAll();
      this.activeInterruptResolvers.add(onInterruptResolve);

      if (this.keepAliveInterval) {
        clearInterval(this.keepAliveInterval);
      }
      this.keepAliveInterval = setInterval(() => {
        if (typeof window !== 'undefined' && 'speechSynthesis' in window && window.speechSynthesis.speaking) {
          window.speechSynthesis.pause();
          window.speechSynthesis.resume();
        }
      }, 8000);

      const speakNextChunk = () => {
        if (myGen !== undefined && this.generation !== myGen) {
          finishAll();
          return;
        }

        if (chunkIdx >= chunks.length) {
          options.onEnd?.();
          finishAll();
          return;
        }

        const chunkText = chunks[chunkIdx];
        chunkIdx++;

        this.beginUtteranceTracking(chunkText, tunedRate);

        const utterance = new SpeechSynthesisUtterance(chunkText);
        this.activeUtterance = utterance;
        utterance.lang = lang;
        if (selectedVoice) {
          utterance.voice = selectedVoice;
        }
        utterance.rate = tunedRate;
        utterance.pitch = tunedPitch;
        utterance.volume = options.volume ?? 1.0;

        let chunkFinished = false;
        let started = false;
        const finishChunk = () => {
          if (chunkFinished) return;
          chunkFinished = true;
          if (this.safetyTimer) {
            clearTimeout(this.safetyTimer);
            this.safetyTimer = null;
          }
        };

        // Dead-utterance stall guard: only advance if the utterance never started
        // and the browser synthesis engine is completely idle.
        this.safetyTimer = setTimeout(() => {
          if (chunkFinished || started) return;
          const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
          if (synth && !synth.speaking && !synth.pending) {
            finishChunk();
            speakNextChunk();
          }
        }, 5000);

        utterance.onstart = () => {
          started = true;
          if (this.safetyTimer) {
            clearTimeout(this.safetyTimer);
            this.safetyTimer = null;
          }
          this.speaking = true;
          this.markUtterancePlaybackStarted();
          if (!hasStarted) {
            hasStarted = true;
            const firstAudioTs = Date.now();
            options.onFirstAudio?.();
            if (options.turnId) {
              try {
                const t0 = options.sttFinalizedAt ?? options.turnStartedAt;
                runLedger.recordVoiceClassification(options.turnId, {
                  ttsEngine: 'browser',
                });
                runLedger.recordVoiceMilestones(options.turnId, {
                  firstAudioAt: firstAudioTs,
                });
                emitTrace({
                  turnId: options.turnId,
                  ev: 'tts.first_audio',
                  engine: 'browser',
                  firstAudioAt: firstAudioTs,
                  ttfaMs: t0 ? Math.max(0, firstAudioTs - t0) : undefined,
                });
              } catch {}
            }
            options.onStart?.();
          }
        };

        utterance.onend = () => {
          if (myGen === undefined || this.generation === myGen) {
            this.markUtteranceCompleted(chunkText);
          }
          finishChunk();
          speakNextChunk();
        };

        utterance.onerror = (e) => {
          finishChunk();
          if (chunkIdx >= chunks.length) {
            options.onError?.(e);
            finishAll();
          } else {
            speakNextChunk();
          }
        };

        try {
          window.speechSynthesis.speak(utterance);
        } catch (err) {
          options.onError?.(err);
          finishAll();
        }
      };

      speakNextChunk();
    });
  }
}

export const ttsNarrator = new TTSNarrator();
