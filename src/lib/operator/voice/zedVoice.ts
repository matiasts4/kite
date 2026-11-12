/**
 * Kite Code — Zed Voice & Speech-to-Text Engine
 *
 * Provides native voice-to-text dictation for the Zed Assistant Orb.
 * Supports:
 *  1. Dual recording: MediaRecorder + Web Audio API 16-bit PCM WAV (fail-safe).
 *  2. Cloud Transcription via Grok / xAI API (whisper-large-v3 / Grok Audio).
 *  3. Cloud Transcription via Cloudflare Workers AI (@cf/openai/whisper) zero-config fallback.
 *  4. Native browser SpeechRecognition (es-ES) fallback when available.
 *  5. Real-time Web Audio API frequency analysis for reactive spherical orb pulses.
 */

import { loadOperatorConfig, syncNativeCredentialsWithVault } from '../operatorConfig';
import { isTauriEnvironment } from '../../ipc';
import { startAudioDucking, stopAudioDucking } from './audioDucking';
import { emitTrace } from '../trace/trace';
import { joinSpeechPartial } from './speechPartial';

// Re-export submodules for clean modular architecture & 100% backward compatibility
export {
  WHISPER_SILENCE_HALLUCINATIONS,
  CJK_REGEX,
  cleanTranscriptionText,
  blobToBase64,
  encodeWavBlob,
} from './wavEncoder';

export {
  transcribeWithGrokCloud,
  transcribeWithCloudflareWhisper,
} from './transcriptionProviders';

export {
  type VoiceEngineStatus,
  getSpeechRecognitionImpl,
  isVoiceRecognitionSupported,
  getVoiceEngineStatus,
} from './voiceStatus';

export {
  type AudioInputDeviceInfo,
  type MicrophoneTester,
  describeMicrophoneError,
  getAudioInputStream,
  listAudioInputDevices,
  startMicrophoneTest,
  stopCapturedStreams,
} from './audioDevices';

export {
  type TranscriptionTestResult,
  type TranscriptionTestSession,
  startTranscriptionTestSession,
} from './transcriptionTest';

import {
  encodeWavBlob,
  cleanTranscriptionText,
} from './wavEncoder';
import {
  transcribeWithGrokCloud,
  transcribeWithCloudflareWhisper,
} from './transcriptionProviders';
import {
  getSpeechRecognitionImpl,
  isVoiceRecognitionSupported,
} from './voiceStatus';
import {
  describeMicrophoneError,
  getAudioInputStream,
  stopCapturedStreams,
} from './audioDevices';

let activeRecognition: any = null;
let activeMediaRecorder: MediaRecorder | null = null;
let activeAudioContext: AudioContext | null = null;
let activeProcessor: ScriptProcessorNode | null = null;
let activeAnalyser: AnalyserNode | null = null;
let activeMediaStream: MediaStream | null = null;
let audioLevel = 0;

let currentSessionPromise: {
  resolve: (text: string) => void;
  reject: (err: any) => void;
} | null = null;

let currentRecordedChunks: Blob[] = [];
let rawPcmChunks: Float32Array[] = [];
let audioSampleRate = 16000;
let currentSpeechTranscript = '';
let currentOptions: StartListeningOptions = {};
let isSessionActive = false;

export function getCurrentAudioLevel(): number {
  if (!activeAnalyser) return 0;
  try {
    const buffer = new Uint8Array(activeAnalyser.frequencyBinCount);
    activeAnalyser.getByteFrequencyData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      sum += buffer[i];
    }
    const avg = sum / buffer.length / 255;
    audioLevel = Math.max(avg * 1.8, audioLevel * 0.85);
    return Math.min(1, audioLevel);
  } catch {
    return 0;
  }
}

export interface StartListeningOptions {
  language?: string;
  deviceId?: string | null;
  onInterim?: (partial: string) => void;
  onAudioLevel?: (level: number) => void;
  onTranscribing?: () => void;
  onError?: (err: string) => void;
}

let startingPromise: Promise<void> | null = null;
let recordingStartTime = 0;
let silenceTimer: any = null;
let hasDetectedSpeech = false;
let lastInterimTranscript = '';

async function transcribeOperatorAudioBlob(audioBlob: Blob): Promise<string> {
  let grokKey = '';
  let grokBaseUrl = 'https://api.x.ai/v1';
  let grokModel = 'grok-voice-transcribe-2.0';
  let cfAccount = '';
  let cfToken = '';
  try {
    const config = loadOperatorConfig();
    grokKey = config.grokTranscriptionApiKey || config.grokApiKey || '';
    grokBaseUrl = config.grokTranscriptionBaseUrl || config.grokBaseUrl || 'https://api.x.ai/v1';
    grokModel = config.grokTranscriptionModel || 'grok-voice-transcribe-2.0';
    cfAccount = config.cloudflareAccountId || '';
    cfToken = config.cloudflareApiToken || '';
    if (!grokKey && typeof localStorage !== 'undefined') {
      grokKey = localStorage.getItem('kite_grok_transcription_api_key') || '';
    }
    if (!grokKey && (!cfAccount.trim() || !cfToken.trim()) && isTauriEnvironment()) {
      const synced = await syncNativeCredentialsWithVault();
      grokKey = synced.grokTranscriptionApiKey || synced.grokApiKey || '';
      cfAccount = synced.cloudflareAccountId || cfAccount;
      cfToken = synced.cloudflareApiToken || cfToken;
    }
  } catch {}

  const hasGrok = Boolean(grokKey && grokKey.trim().length > 0);
  const hasCf = Boolean(cfAccount.trim() && cfToken.trim());

  if (!hasGrok && !hasCf) {
    throw new Error(
      'Falta configurar la API Key de Grok (xAI) o las credenciales de Cloudflare Whisper para la transcripción de voz en los Ajustes del Asistente.'
    );
  }

  let grokErr: unknown = null;
  if (hasGrok && audioBlob.size > 200) {
    try {
      return await transcribeWithGrokCloud(audioBlob, grokKey, grokBaseUrl, grokModel);
    } catch (err) {
      grokErr = err;
      console.warn('[ZedVoice] Grok Cloud avisó error, probando Cloudflare Whisper como respaldo:', err);
    }
  }

  if (hasCf) {
    return transcribeWithCloudflareWhisper(audioBlob, cfAccount, cfToken);
  }

  if (grokErr) {
    const errMsg = (grokErr as Error)?.message || String(grokErr);
    throw new Error(`Falló la transcripción con Grok (${errMsg}) y no hay credenciales de Cloudflare Whisper como respaldo.`);
  }

  throw new Error('Falta configurar la API Key de Grok o credenciales de transcripción válidas.');
}

function resetSilenceTimer(): void {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  if (!isSessionActive || !hasDetectedSpeech) return;

  // Auto-stop after 3.2 seconds of silence once speech was genuine and confirmed
  silenceTimer = setTimeout(() => {
    if (isSessionActive && hasDetectedSpeech) {
      console.log('[ZedVoice] Silencio detectado tras voz activa (3.2s), finalizando turno automáticamente.');
      void stopOperatorListening();
    }
  }, 3200);
}

/**
 * Starts capturing audio and transcribing speech.
 * Stays active until stopOperatorListening() is invoked.
 */
export async function startOperatorListening(
  options: StartListeningOptions = {}
): Promise<string> {
  if (!isVoiceRecognitionSupported()) {
    const msg = 'El reconocimiento de voz no está soportado en este entorno.';
    options.onError?.(msg);
    return Promise.reject(new Error(msg));
  }

  // Drop a stale capture without transcribing it or flipping the orb to "thinking".
  await stopOperatorListening({ discard: true });

  currentOptions = options;
  currentRecordedChunks = [];
  rawPcmChunks = [];
  currentSpeechTranscript = '';
  lastInterimTranscript = '';
  hasDetectedSpeech = false;
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  isSessionActive = true;
  recordingStartTime = Date.now();

  startingPromise = (async () => {
    // 1. Get default microphone stream
    if (typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function') {
      try {
        const stream = await getAudioInputStream(options.deviceId);
        if (!isSessionActive) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        activeMediaStream = stream;
        await startAudioDucking();

        const AudioContextClass =
          window.AudioContext || (window as any).webkitAudioContext;
        if (AudioContextClass) {
          try {
            activeAudioContext = new AudioContextClass();
            if (activeAudioContext.state === 'suspended') {
              try {
                await activeAudioContext.resume();
              } catch {}
            }
            audioSampleRate = activeAudioContext.sampleRate || 16000;
            const source = activeAudioContext.createMediaStreamSource(stream);
            const analyser = activeAudioContext.createAnalyser();
            analyser.fftSize = 64;
            source.connect(analyser);
            activeAnalyser = analyser;

            // Direct Web Audio PCM capture (foolproof backup that captures audio even if MediaRecorder fails)
            try {
              const processor = activeAudioContext.createScriptProcessor(4096, 1, 1);
              processor.onaudioprocess = (e) => {
                if (!isSessionActive) return;
                const input = e.inputBuffer.getChannelData(0);
                rawPcmChunks.push(new Float32Array(input));
              };
              source.connect(processor);
              processor.connect(activeAudioContext.destination);
              activeProcessor = processor;
            } catch {}
          } catch {}
        }

        if (typeof MediaRecorder !== 'undefined') {
          try {
            const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
              ? 'audio/webm;codecs=opus'
              : MediaRecorder.isTypeSupported('audio/webm')
              ? 'audio/webm'
              : MediaRecorder.isTypeSupported('audio/mp4')
              ? 'audio/mp4'
              : '';
            const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
            recorder.ondataavailable = (e) => {
              if (e.data && e.data.size > 0) {
                currentRecordedChunks.push(e.data);
              }
            };
            recorder.start(150);
            activeMediaRecorder = recorder;
          } catch (e) {
            console.warn('[ZedVoice] MediaRecorder error:', e);
          }
        }
      } catch (err: any) {
        console.error('[ZedVoice] getUserMedia error:', err);
        const userMsg =
          err instanceof Error && /micrófono|Permiso|No se detectó|ocupado/i.test(err.message)
            ? err.message
            : describeMicrophoneError(err);
        options.onError?.(userMsg);
        await releaseOperatorCapture();
        throw new Error(userMsg);
      }
    }

    // 2. Start SpeechRecognition in continuous mode for live partial transcript if available
    const SpeechImpl = getSpeechRecognitionImpl();
    if (SpeechImpl) {
      try {
        const recognition = new SpeechImpl();
        recognition.lang = options.language || 'es-ES';
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;

        recognition.onresult = (event: any) => {
          let interim = '';
          for (let i = event.resultIndex; i < event.results.length; ++i) {
            const item = event.results[i];
            if (item.isFinal) {
              currentSpeechTranscript = joinSpeechPartial(currentSpeechTranscript, item[0].transcript);
            } else {
              interim += item[0].transcript;
            }
          }
          lastInterimTranscript = interim;
          const currentText = joinSpeechPartial(currentSpeechTranscript, interim);
          if (currentText.length > 1) {
            hasDetectedSpeech = true;
            resetSilenceTimer();
          }
          if (options.onInterim) {
            options.onInterim(currentText);
          }
        };

        recognition.onerror = (event: any) => {
          if (event.error !== 'no-speech' && event.error !== 'aborted') {
            console.warn('[ZedVoice] Reconocimiento aviso:', event.error);
          }
        };

        recognition.onend = () => {
          currentSpeechTranscript = joinSpeechPartial(currentSpeechTranscript, lastInterimTranscript);
          lastInterimTranscript = '';
          if (currentSpeechTranscript && options.onInterim) {
            options.onInterim(currentSpeechTranscript);
          }
          if (isSessionActive && activeRecognition === recognition) {
            try {
              recognition.start();
            } catch {}
          }
        };

        activeRecognition = recognition;
        recognition.start();
      } catch (e) {
        console.warn('[ZedVoice] SpeechRecognition start warning:', e);
      }
    }
  })();

  try {
    await startingPromise;
  } finally {
    startingPromise = null;
  }

  return new Promise<string>((resolve, reject) => {
    currentSessionPromise = { resolve, reject };
  });
}

/**
 * Stops capturing audio, finalizes transcription (Grok Cloud or Cloudflare Whisper Cloud),
 * and resolves the pending startOperatorListening() Promise.
 */
export async function stopOperatorListening(options?: { discard?: boolean }): Promise<string> {
  const discard = options?.discard === true;
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  hasDetectedSpeech = false;

  if (startingPromise) {
    try {
      await startingPromise;
    } catch {}
  }

  const wasRecording = isSessionActive;

  // Ensure at least 300ms has elapsed so audio buffers are flushed and populated
  const elapsed = Date.now() - recordingStartTime;
  if (!discard && elapsed < 300 && wasRecording) {
    await new Promise((r) => setTimeout(r, 300 - elapsed));
  }

  isSessionActive = false;
  const promise = currentSessionPromise;
  currentSessionPromise = null;

  if (discard) {
    currentOptions = {};
    if (activeRecognition) {
      try {
        activeRecognition.onend = null;
        activeRecognition.stop();
      } catch {
        // ignore
      }
      activeRecognition = null;
    }
    if (activeMediaRecorder && activeMediaRecorder.state !== 'inactive') {
      try {
        activeMediaRecorder.stop();
      } catch {
        // ignore
      }
    }
    activeMediaRecorder = null;
    stopAudioAnalysis();
    void stopAudioDucking();
    rawPcmChunks = [];
    currentRecordedChunks = [];
    if (promise) promise.resolve('');
    return '';
  }

  if (wasRecording) {
    currentOptions.onTranscribing?.();
  }

  void stopAudioDucking();

  // 1. Stop SpeechRecognition
  if (activeRecognition) {
    try {
      activeRecognition.onend = null;
      activeRecognition.stop();
    } catch {}
    activeRecognition = null;
  }

  // 2. Stop MediaRecorder, request remaining data and wait (with safety timeout)
  if (activeMediaRecorder && activeMediaRecorder.state !== 'inactive') {
    try {
      activeMediaRecorder.requestData();
    } catch {}
    await new Promise<void>((res) => {
      if (!activeMediaRecorder) return res();
      let finished = false;
      const done = () => {
        if (!finished) {
          finished = true;
          res();
        }
      };
      activeMediaRecorder.onstop = done;
      const timer = setTimeout(done, 600);
      try {
        activeMediaRecorder.stop();
      } catch {
        clearTimeout(timer);
        done();
      }
    });
    activeMediaRecorder = null;
  }

  // 3. Resolve audio blob: Prioritize lossless 16-bit PCM WAV (16kHz Whisper native standard)
  let audioBlob: Blob | null = null;
  if (rawPcmChunks.length > 0) {
    try {
      audioBlob = encodeWavBlob(rawPcmChunks, audioSampleRate);
    } catch (e) {
      console.warn('[ZedVoice] encodeWavBlob error:', e);
    }
  }

  // Dual recording fallback: If raw PCM was somehow empty, fallback to MediaRecorder chunks
  if (!audioBlob && currentRecordedChunks.length > 0) {
    const candidate = new Blob(currentRecordedChunks, {
      type: currentRecordedChunks[0]?.type || 'audio/webm',
    });
    if (candidate.size > 200) {
      audioBlob = candidate;
    }
  }

  // 4. Stop audio stream & analyser
  stopAudioAnalysis();

  // 5. Resolve transcription (single cloud request — lowest latency for Zed turns)
  let finalText = '';
  let lastError = '';
  const durationSecs = Math.max(0.5, (Date.now() - recordingStartTime) / 1000);

  if (audioBlob && audioBlob.size > 200) {
    try {
      finalText = await transcribeOperatorAudioBlob(audioBlob);
    } catch (err: any) {
      lastError = err?.message || 'Error en transcripción';
      console.warn('[ZedVoice] Transcripción cloud error:', err);
    }
  }

  // Priority 3: Native speech transcript fallback (both final and interim)
  if (!finalText && (currentSpeechTranscript || lastInterimTranscript)) {
    finalText = (currentSpeechTranscript || lastInterimTranscript).trim();
  }

  // Drop hallucinated phrases from silence
  if (finalText) {
    finalText = cleanTranscriptionText(finalText, durationSecs);
  }

  if (!finalText) {
    const discardReason =
      !audioBlob || audioBlob.size <= 200
        ? 'Grabación vacía o de duración mínima'
        : lastError && !(currentSpeechTranscript || lastInterimTranscript)
          ? `Fallo al transcribir: ${lastError}`
          : 'No se detectaron palabras legibles en el audio';

    try {
      const voiceTurnId = `voice-${Date.now()}`;
      emitTrace({
        turnId: voiceTurnId,
        ev: 'turn.start',
        input: `[captura de voz descartada: ${discardReason}]`,
        source: 'voz',
      });
      emitTrace({
        turnId: voiceTurnId,
        ev: 'turn.end',
        overallSuccess: false,
        error: discardReason,
        durationMs: Math.round(durationSecs * 1000),
      });
    } catch {}

    if (!audioBlob || audioBlob.size <= 200) {
      console.log('[ZedVoice] Grabación vacía o de duración mínima, volviendo a reposo limpiamente.');
    } else if (lastError && !(currentSpeechTranscript || lastInterimTranscript)) {
      currentOptions.onError?.(`Fallo al transcribir: ${lastError}`);
    } else if (audioBlob && audioBlob.size > 200) {
      currentOptions.onError?.(
        'No se entendió lo que dijiste. Prueba hablar más claro o más cerca del micrófono.'
      );
    }
  }

  lastInterimTranscript = '';

  if (promise) {
    promise.resolve(finalText);
  }

  return finalText;
}

function stopAudioAnalysis(): void {
  if (activeProcessor) {
    try {
      activeProcessor.disconnect();
    } catch {}
    activeProcessor = null;
  }
  if (activeMediaStream) {
    try {
      activeMediaStream.getTracks().forEach((track) => track.stop());
    } catch {}
    activeMediaStream = null;
  }
  if (activeAudioContext) {
    try {
      activeAudioContext.close();
    } catch {}
    activeAudioContext = null;
  }
  activeAnalyser = null;
  audioLevel = 0;
  rawPcmChunks = [];
  stopCapturedStreams();
}

/**
 * Drops any microphone capture Zed still holds and restores ducked volume.
 * Used when listening fails, and when the assistant is closed or minimized.
 */
export async function releaseOperatorCapture(): Promise<void> {
  isSessionActive = false;
  hasDetectedSpeech = false;
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  if (activeRecognition) {
    try {
      activeRecognition.onend = null;
      activeRecognition.stop();
    } catch {
      // ignore
    }
    activeRecognition = null;
  }
  if (activeMediaRecorder && activeMediaRecorder.state !== 'inactive') {
    try {
      activeMediaRecorder.stop();
    } catch {
      // ignore
    }
  }
  activeMediaRecorder = null;
  stopAudioAnalysis();
  const pending = currentSessionPromise;
  currentSessionPromise = null;
  if (pending) pending.resolve('');
  await stopAudioDucking();
}
