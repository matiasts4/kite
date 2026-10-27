// Kite Code — TTS Narrator
// Speech synthesis engine for reading agent outputs, terminal summaries, and operator feedback aloud.
// Supports:
//  1. High-fidelity Neural Streaming via ElevenLabs (eleven_v4_turbo / eleven_flash_v2_5) with zero-latency abort.
//  2. Native Web Speech API fallback with smart speech-cleaning filters, persona voice modulation,
//     and natural neural voice prioritization.
import { sanitizeReply } from './planner/sanitize';
import { loadOperatorConfig } from './operatorConfig';

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
  onStart?: () => void;
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
 * Strips code blocks, markdown symbols, URLs, and noisy syntax so text reads naturally.
 */
export function cleanTextForSpeech(text: string): string {
  if (!text) return '';

  let cleaned = text;

  // Replace code blocks with descriptive pause
  cleaned = cleaned.replace(/```[\s\S]*?```/g, ' bloque de código omitido ');

  // Strip inline backticks
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');

  // Markdown links [title](url) -> title
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Markdown headers, bold, italics
  cleaned = cleaned.replace(/^#+\s+/gm, '');
  cleaned = cleaned.replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1');

  // Strip bullet markers and numbered list markers
  cleaned = cleaned.replace(/^[-*+]\s+/gm, '');
  cleaned = cleaned.replace(/^\d+\.\s+/gm, '');

  // Strip common noisy symbols and emojis
  cleaned = cleaned.replace(/[📋🚀⚠️✅❌🔥✨🔍🛠️📦💻💬🤖⚡🔴🟢🔵]/g, '');

  // Replace tech symbols with natural speech pauses
  cleaned = cleaned.replace(/&&|\|\|/g, ' y ');
  cleaned = cleaned.replace(/!=|!==/g, ' distinto de ');
  cleaned = cleaned.replace(/==|===/g, ' igual a ');
  cleaned = cleaned.replace(/->|=>/g, ' hacia ');

  // Soften colons and slashes for natural breathing cadence
  cleaned = cleaned.replace(/:\s+/g, ', ');
  cleaned = cleaned.replace(/\s*—\s*/g, ', ');

  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
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

class TTSNarrator {
  private speaking = false;
  private activeUtterance: SpeechSynthesisUtterance | null = null;
  private activeAudio: HTMLAudioElement | null = null;
  private activeAudioUrl: string | null = null;
  private activeAbortController: AbortController | null = null;
  private safetyTimer: any = null;
  private generation = 0;

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

  public stop(): void {
    this.generation++;
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
    this.speaking = false;
    this.activeUtterance = null;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
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

  public async speak(text: string, optionsOrLang: TTSOptions | string = {}): Promise<void> {
    const options: TTSOptions =
      typeof optionsOrLang === 'string' ? { lang: optionsOrLang } : optionsOrLang;

    // Cancel any previous speech and record generation
    this.stop();
    const myGen = this.generation;

    // Sanitize to prevent prompt echo, code fences or noise from reaching TTS
    const sanitized = sanitizeReply(text, '');
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
        await this.speakElevenLabs(textToSpeak, options, config, myGen);
        return;
      } catch (err: any) {
        // If interrupted, stopped by user, or superseded, NEVER fall back to local voice!
        if (
          this.generation !== myGen ||
          err?.name === 'AbortError' ||
          err?.code === 20 ||
          err?.type === 'error' ||
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

    return this.speakBrowser(textToSpeak, options, myGen);
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

    const controller = new AbortController();
    this.activeAbortController = controller;

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      voiceId
    )}/stream?output_format=mp3_44100_128`;

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

      let finished = false;
      const cleanup = () => {
        if (finished) return;
        finished = true;
        this.speaking = false;
        if (this.activeAudio === audio) {
          this.activeAudio = null;
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
        options.onStart?.();
      };

      audio.onended = () => {
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
        options.onError?.(e);
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

    return new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(textToSpeak);
      this.activeUtterance = utterance;

      const lang =
        options.lang ||
        (/[áéíóúñ¿¡]|\b(el|la|los|las|de|en|y|o|para|con)\b/i.test(textToSpeak)
          ? 'es-ES'
          : 'en-US');
      utterance.lang = lang;

      const selectedVoice = resolveBestVoice(voices, options.voiceName, lang);
      if (selectedVoice) {
        utterance.voice = selectedVoice;
      }

      const profileKey = Object.keys(PERSONA_VOICE_PROFILES).find(
        (k) => k.toLowerCase() === (options.voiceName || 'Ara').toLowerCase()
      );
      const profile = profileKey ? PERSONA_VOICE_PROFILES[profileKey] : PERSONA_VOICE_PROFILES.Ara;

      const baseRate = options.rate ?? 1.0;
      const basePitch = options.pitch ?? 1.0;

      const tunedRate = Math.min(1.45, Math.max(0.75, baseRate * profile.rateMultiplier));
      const tunedPitch = Math.min(1.3, Math.max(0.8, basePitch * profile.pitchMultiplier));

      utterance.rate = tunedRate;
      utterance.pitch = tunedPitch;
      utterance.volume = options.volume ?? 1.0;

      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (this.safetyTimer) {
          clearTimeout(this.safetyTimer);
          this.safetyTimer = null;
        }
        this.speaking = false;
        this.activeUtterance = null;
        resolve();
      };

      const maxMs = Math.max(3000, Math.ceil((textToSpeak.length / 7) * 1000) + 3000);
      this.safetyTimer = setTimeout(() => {
        if (!finished) {
          options.onEnd?.();
          finish();
        }
      }, maxMs);

      utterance.onstart = () => {
        this.speaking = true;
        options.onStart?.();
      };

      utterance.onend = () => {
        options.onEnd?.();
        finish();
      };

      utterance.onerror = (e) => {
        options.onError?.(e);
        finish();
      };

      if (myGen !== undefined && this.generation !== myGen) {
        finish();
        return;
      }

      try {
        window.speechSynthesis.speak(utterance);
      } catch (speakErr) {
        options.onError?.(speakErr);
        finish();
      }
    });
  }
}

export const ttsNarrator = new TTSNarrator();
