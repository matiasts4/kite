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
import {
  joinSpeechPartial,
  isSpanishOpenClause,
  SpeculativePartialPreCapture,
} from './speechPartial';
import { getCachedLiveChatCatalog } from './sessionPrewarm';
import { buildEnrichedTurnContext } from '../context/workspaceSnapshot';
import type { TurnContext } from '../contract';
import {
  decodeWavBase64ToBlob,
  getCachedNativeAudioLevel,
  isNativeRustAudioSupported,
  markNativeSpeechStart,
  setCachedNativeAudioLevel,
  setNativeAudioMuted,
  startNativeAudioCapture,
  stopNativeAudioCapture,
  subscribeNativeAudioEvents,
} from './nativeAudioBridge';
export { joinSpeechPartial, isSpanishOpenClause };
import {
  AdaptiveVadController,
  BargeInGate,
  PcmPreRollBuffer,
  PreConnectAudioRingBuffer,
  computeAdaptiveEndpointMs,
  computeRms,
  trimTrailingPcmSamples,
} from './adaptiveVad';
export { PreConnectAudioRingBuffer } from './adaptiveVad';
import { voiceTurnArbitrator } from './turnArbitrator';

// Re-export submodules for clean modular architecture & 100% backward compatibility
export {
  WHISPER_SILENCE_HALLUCINATIONS,
  CJK_REGEX,
  cleanTranscriptionText,
  blobToBase64,
  encodeWavBlob,
} from './wavEncoder';

export {
  type SttErrorCode,
  type WebSocketLike,
  type WebSocketConstructorLike,
  type OpenGrokStreamingSttOptions,
  type GrokStreamingSttSession,
  SttProviderError,
  isFatalSttError,
  transcribeWithGrokCloud,
  transcribeWithCloudflareWhisper,
  openGrokStreamingSttSession,
  streamTranscribeWithGrokWs,
  buildGrokSttWsUrl,
  float32ToInt16Pcm,
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
  openGrokStreamingSttSession,
  type GrokStreamingSttSession,
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
let activeWorkletNode: AudioWorkletNode | null = null;
let activeWorkletUrl: string | null = null;
let activeSilentGain: GainNode | null = null;
let activeAnalyser: AnalyserNode | null = null;
let activeMediaStream: MediaStream | null = null;
let audioLevel = 0;

const IDLE_NO_SPEECH_MS = 8000;
const TRAILING_SILENCE_PAD_MS = 250;
const PCM_WORKLET_PROCESSOR_NAME = 'kite-pcm-vad-processor';
const PCM_WORKLET_SOURCE = `
class KitePcmVadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(2048);
    this._offset = 0;
  }
  process(inputs) {
    const input = inputs && inputs[0] && inputs[0][0];
    if (!input || input.length === 0) return true;
    let i = 0;
    while (i < input.length) {
      const space = this._buf.length - this._offset;
      const take = Math.min(space, input.length - i);
      this._buf.set(input.subarray(i, i + take), this._offset);
      this._offset += take;
      i += take;
      if (this._offset >= this._buf.length) {
        const out = this._buf;
        this.port.postMessage(out, [out.buffer]);
        this._buf = new Float32Array(2048);
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('${PCM_WORKLET_PROCESSOR_NAME}', KitePcmVadProcessor);
`;

const adaptiveVad = new AdaptiveVadController();
const bargeInGate = new BargeInGate();
let preRollBuffer = new PcmPreRollBuffer(16000, 400);
const preConnectBuffer = new PreConnectAudioRingBuffer({
  maxDurationMs: 20000,
  sampleRate: 16000,
  leadingSilenceThreshold: 0.003,
  preRollMs: 100,
});
let wsHandshakeBuffer: PreConnectAudioRingBuffer | null = null;
let bargeInCallback: (() => void) | null = null;
let isBargeInMonitoring = false;
let isPersistentGraphActive = false;
let currentTurnTraceId = '';
let speechStartTimestamp = 0;
let lastSilenceWindowMs = 1150;
let currentContinuousMode = false;

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
let isSpeechCaptureOpen = false;
let hasVadVoicedFrame = false;
let trailingSilenceSamples = 0;
let lastRecognizedText = '';
let activeStreamingStt: GrokStreamingSttSession | null = null;
let streamingSttTranscript = '';
let sessionMuted = false;
let recognitionEpoch = 0;
let recognitionRestartTimer: ReturnType<typeof setTimeout> | null = null;
let nativeCaptureActive = false;
let nativeStreamWarm = false;
let nativeDevicePref: string | null = null;
let lastNativeLevelTs = 0;
let nativeEventUnsub: (() => void) | null = null;

const speculativePreCapture = new SpeculativePartialPreCapture<TurnContext>({
  stabilityMs: 250,
  onStable: async (partial) => {
    const ctx = await buildEnrichedTurnContext().catch(() => null);
    if (/\b(?:chat|chats|hilo|hilos|thread|threads|ayer|anoche|memoria)\b/i.test(partial)) {
      void getCachedLiveChatCatalog(ctx?.workspaceId).catch(() => {});
    }
    return ctx;
  },
});

export function consumeSpeculativeTurnContext(finalText: string): TurnContext | null {
  return speculativePreCapture.consume(finalText);
}

export function resetSpeculativeTurnContextForTests(): void {
  speculativePreCapture.reset();
}

export function getCurrentAudioLevel(): number {
  if (nativeCaptureActive || nativeStreamWarm) {
    const nativeLevel = getCachedNativeAudioLevel();
    audioLevel = Math.max(nativeLevel, audioLevel * 0.85);
    return Math.min(1, audioLevel);
  }
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
  /** True inside continuous Voice Mode calls so the audio graph stays warm without 8s teardown churn. */
  continuous?: boolean;
  /** True when starting immediately from an acoustic barge-in so pre-roll PCM is preserved. */
  fromBargeIn?: boolean;
  onInterim?: (partial: string) => void;
  onAudioLevel?: (level: number) => void;
  onTranscribing?: () => void;
  onError?: (err: string) => void;
}

let startingPromise: Promise<void> | null = null;
let recordingStartTime = 0;
let silenceTimer: any = null;
let noSpeechTimer: any = null;
let hasDetectedSpeech = false;
let lastInterimTranscript = '';

function clearVadTimers(): void {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  if (noSpeechTimer) {
    clearTimeout(noSpeechTimer);
    noSpeechTimer = null;
  }
}

function armNoSpeechTimer(): void {
  if (noSpeechTimer) {
    clearTimeout(noSpeechTimer);
    noSpeechTimer = null;
  }
  // In continuous persistent voice sessions, stay quietly armed without tearing down the mic every 8s.
  if (!isSessionActive || hasDetectedSpeech || currentContinuousMode) return;
  noSpeechTimer = setTimeout(() => {
    if (isSessionActive && !hasDetectedSpeech && !currentContinuousMode) {
      void stopOperatorListening();
    }
  }, IDLE_NO_SPEECH_MS);
}

/**
 * Arms echo-resistant acoustic barge-in monitoring while SETH is speaking TTS.
 * Keeps the persistent microphone graph alive, buffers 400ms pre-roll PCM, and invokes
 * `onBargeIn` immediately upon sustained human speech onset.
 */
export function armBargeInMonitor(onBargeIn: () => void): boolean {
  if (!nativeStreamWarm && (!activeMediaStream || !activeAudioContext)) {
    return false;
  }
  bargeInCallback = onBargeIn;
  isBargeInMonitoring = true;
  bargeInGate.arm(Date.now());
  return true;
}

export function disarmBargeInMonitor(): void {
  isBargeInMonitoring = false;
  bargeInCallback = null;
  bargeInGate.disarm();
}

function resolveGrokSttConfigSync(): {
  grokKey: string;
  grokBaseUrl: string;
  grokModel: string;
  cfAccount: string;
  cfToken: string;
} {
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
  } catch {}
  return { grokKey, grokBaseUrl, grokModel, cfAccount, cfToken };
}

function startStreamingSttIfConfigured(initialChunks: Float32Array[] = []): void {
  if (sessionMuted || activeStreamingStt || !isSessionActive) return;
  const { grokKey, grokBaseUrl } = resolveGrokSttConfigSync();
  if (!grokKey || !grokKey.trim()) return;

  const handshakeRing = new PreConnectAudioRingBuffer({
    maxDurationMs: 20000,
    sampleRate: audioSampleRate,
    leadingSilenceThreshold: 0,
    preRollMs: 0,
  });
  let handshakeCompleted = false;

  const session = openGrokStreamingSttSession({
    apiKey: grokKey,
    baseUrl: grokBaseUrl,
    language: currentOptions.language || 'es-ES',
    endpointingMs: 400,
    onOpen: () => {
      if (!session || activeStreamingStt !== session || !isSessionActive) {
        handshakeRing.clear();
        return;
      }
      handshakeCompleted = true;
      const queued = handshakeRing.releaseAndDrain();
      for (const chunk of queued) {
        session.sendFloat32(chunk, audioSampleRate);
      }
    },
    onPartial: (partial) => {
      if (!isSessionActive || activeStreamingStt !== session) return;
      const clean = partial.trim();
      if (!clean) return;
      streamingSttTranscript = clean;
      hasDetectedSpeech = true;
      if (!speechStartTimestamp) {
        speechStartTimestamp = Date.now();
      }
      if (clean !== lastRecognizedText) {
        lastRecognizedText = clean;
        trailingSilenceSamples = 0;
      }
      resetSilenceTimer();
      speculativePreCapture.update(clean);
      currentOptions.onInterim?.(clean);
    },
    onFinal: (finalText) => {
      if (!isSessionActive || activeStreamingStt !== session) return;
      const clean = finalText.trim();
      if (!clean) return;
      streamingSttTranscript = clean;
      lastRecognizedText = clean;
      resetSilenceTimer();
      speculativePreCapture.update(clean);
      currentOptions.onInterim?.(clean);
    },
    onError: (err) => {
      handshakeRing.clear();
      if (wsHandshakeBuffer === handshakeRing) {
        wsHandshakeBuffer = null;
      }
      console.warn('[ArgosVoice] Streaming STT fallback a WAV:', err);
    },
  });

  if (!session) {
    handshakeRing.clear();
    return;
  }
  activeStreamingStt = session;
  if (session.isOpen()) {
    handshakeCompleted = true;
    wsHandshakeBuffer = null;
    for (const chunk of initialChunks) {
      session.sendFloat32(chunk, audioSampleRate);
    }
  } else {
    wsHandshakeBuffer = handshakeRing;
    for (const chunk of initialChunks) {
      if (handshakeCompleted || session.isOpen()) {
        session.sendFloat32(chunk, audioSampleRate);
      } else {
        handshakeRing.push(chunk);
      }
    }
  }
}

function openSpeechPcmCapture(): boolean {
  if (isSpeechCaptureOpen) return false;
  isSpeechCaptureOpen = true;
  trailingSilenceSamples = 0;
  const preConnectChunks =
    preConnectBuffer.getState() === 'buffering' ? preConnectBuffer.releaseAndDrain() : [];
  const initialChunks = preConnectChunks.length > 0 ? preConnectChunks : preRollBuffer.drain();
  if (preConnectChunks.length > 0) {
    preRollBuffer.clear();
  }
  if (initialChunks.length > 0) {
    rawPcmChunks.push(...initialChunks);
  }
  startStreamingSttIfConfigured(initialChunks);
  return true;
}

/**
 * Emits `durationMs` (default 500ms) of zeroed PCM frames when muting mid-session
 * so streaming endpointing flushes cleanly without tearing down the audio graph.
 */
export function flushSilenceOnMute(durationMs: number = 500): void {
  const safeRate = Math.max(8000, audioSampleRate);
  const floatSamplesCount = Math.max(256, Math.round((safeRate * durationMs) / 1000));
  const zeroFloat = new Float32Array(floatSamplesCount);
  if (isSpeechCaptureOpen) {
    rawPcmChunks.push(zeroFloat);
    trailingSilenceSamples += zeroFloat.length;
  }
  if (activeStreamingStt && !activeStreamingStt.hasFailed()) {
    if (wsHandshakeBuffer && wsHandshakeBuffer.getState() === 'buffering' && !activeStreamingStt.isOpen()) {
      const queued = wsHandshakeBuffer.releaseAndDrain();
      for (const chunk of queued) {
        activeStreamingStt.sendFloat32(chunk, audioSampleRate);
      }
    }
    const pcm16ZeroCount = Math.max(160, Math.round((16000 * durationMs) / 1000));
    activeStreamingStt.sendPcm16(new Int16Array(pcm16ZeroCount));
  }
  preRollBuffer.clear();
  preConnectBuffer.clear();
  wsHandshakeBuffer?.clear();
  wsHandshakeBuffer = null;
  audioLevel = 0;
}

export function setOperatorMicMuted(muted: boolean): void {
  const next = Boolean(muted);
  if (next === sessionMuted) return;
  sessionMuted = next;
  if (nativeCaptureActive || nativeStreamWarm) {
    setCachedNativeAudioLevel(0);
    void setNativeAudioMuted(next);
  }
  if (next) {
    flushSilenceOnMute(500);
  } else {
    adaptiveVad.resetTurn(true);
  }
}

export function isOperatorMicMuted(): boolean {
  return sessionMuted;
}

function handleNativeAudioLevel(level: number, rms: number, durationMs?: number): void {
  if (sessionMuted) {
    audioLevel = 0;
    return;
  }
  const now = Date.now();
  const frameDurationMs =
    typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
      ? Math.min(200, Math.max(10, durationMs))
      : Math.min(200, Math.max(10, lastNativeLevelTs > 0 ? now - lastNativeLevelTs : 33));
  lastNativeLevelTs = now;

  audioLevel = Math.max(level, audioLevel * 0.85);
  currentOptions.onAudioLevel?.(level);

  if (isBargeInMonitoring && !isSessionActive) {
    if (bargeInGate.evaluateFrame(rms, frameDurationMs, adaptiveVad.getNoiseFloorRms(), now)) {
      isBargeInMonitoring = false;
      const cb = bargeInCallback;
      bargeInCallback = null;
      voiceTurnArbitrator.transition('barge_in');
      try {
        cb?.();
      } catch (err) {
        console.warn('[ArgosVoice] Barge-in callback error:', err);
      }
    }
    return;
  }

  if (!isSessionActive) return;

  const decision = adaptiveVad.processFrame(rms, frameDurationMs);
  if (decision.speechStartedNow) {
    hasDetectedSpeech = true;
    hasVadVoicedFrame = true;
    if (!speechStartTimestamp) {
      speechStartTimestamp = now;
    }
    if (!isSpeechCaptureOpen) {
      isSpeechCaptureOpen = true;
      void markNativeSpeechStart(400);
    }
    trailingSilenceSamples = 0;
    voiceTurnArbitrator.transition('user_speaking');
    try {
      emitTrace({
        turnId: currentTurnTraceId,
        ev: 'vad.speech_start',
        noiseFloorRms: Number(decision.noiseFloorRms.toFixed(4)),
        bargeIn: Boolean(currentOptions.fromBargeIn),
      });
    } catch {}
  }

  if (decision.isVoiced) {
    hasDetectedSpeech = true;
    hasVadVoicedFrame = true;
    if (!speechStartTimestamp) {
      speechStartTimestamp = now;
    }
    if (!isSpeechCaptureOpen) {
      isSpeechCaptureOpen = true;
      void markNativeSpeechStart(400);
    }
    trailingSilenceSamples = 0;
    resetSilenceTimer();
  } else if (isSpeechCaptureOpen) {
    trailingSilenceSamples += Math.round((16000 * frameDurationMs) / 1000);
  }
}

function handlePcmFrame(samples: Float32Array): void {
  if (sessionMuted) {
    return;
  }

  const frameDurationMs = (samples.length / Math.max(8000, audioSampleRate)) * 1000;
  const rms = computeRms(samples);

  // Maintain 400ms circular pre-roll buffer and 20s pre-connect ring buffer while warming up
  preRollBuffer.push(samples);
  if (!isSpeechCaptureOpen && preConnectBuffer.getState() === 'buffering') {
    preConnectBuffer.push(samples);
  }

  if (isBargeInMonitoring && !isSessionActive) {
    if (bargeInGate.evaluateFrame(rms, frameDurationMs, adaptiveVad.getNoiseFloorRms(), Date.now())) {
      isBargeInMonitoring = false;
      const cb = bargeInCallback;
      bargeInCallback = null;
      voiceTurnArbitrator.transition('barge_in');
      try {
        cb?.();
      } catch {}
    }
    return;
  }

  if (!isSessionActive) return;

  const decision = adaptiveVad.processFrame(rms, frameDurationMs);
  let openedCaptureOnThisFrame = false;

  if (decision.speechStartedNow) {
    hasDetectedSpeech = true;
    if (!speechStartTimestamp) {
      speechStartTimestamp = Date.now();
    }
    openedCaptureOnThisFrame = openSpeechPcmCapture();
    voiceTurnArbitrator.transition('user_speaking');
    try {
      emitTrace({
        turnId: currentTurnTraceId,
        ev: 'vad.speech_start',
        noiseFloorRms: Number(decision.noiseFloorRms.toFixed(4)),
        bargeIn: Boolean(currentOptions.fromBargeIn),
      });
    } catch {}
  }

  if (decision.isVoiced) {
    hasDetectedSpeech = true;
    hasVadVoicedFrame = true;
    if (!speechStartTimestamp) {
      speechStartTimestamp = Date.now();
    }
    if (!openedCaptureOnThisFrame) {
      openedCaptureOnThisFrame = openSpeechPcmCapture();
    }
    trailingSilenceSamples = 0;
    resetSilenceTimer();
  }

  // Gate PCM accumulation behind speech onset so idle waiting silence never inflates RAM or STT billing.
  if (isSpeechCaptureOpen) {
    if (!openedCaptureOnThisFrame) {
      rawPcmChunks.push(new Float32Array(samples));
      if (activeStreamingStt && !activeStreamingStt.hasFailed()) {
        if (
          wsHandshakeBuffer &&
          wsHandshakeBuffer.getState() === 'buffering' &&
          !activeStreamingStt.isOpen()
        ) {
          wsHandshakeBuffer.push(samples);
        } else {
          activeStreamingStt.sendFloat32(samples, audioSampleRate);
        }
      }
    }
    if (!decision.isVoiced) {
      trailingSilenceSamples += samples.length;
    }
  }
}

async function transcribeOperatorAudioBlob(audioBlob: Blob): Promise<string> {
  let { grokKey, grokBaseUrl, grokModel, cfAccount, cfToken } = resolveGrokSttConfigSync();
  try {
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
  if (noSpeechTimer) {
    clearTimeout(noSpeechTimer);
    noSpeechTimer = null;
  }
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  if (!isSessionActive || !hasDetectedSpeech) return;

  const localLiveText = joinSpeechPartial(currentSpeechTranscript, lastInterimTranscript);
  const liveText =
    streamingSttTranscript && streamingSttTranscript.length > localLiveText.length
      ? streamingSttTranscript
      : localLiveText;
  const speechDurationMs = speechStartTimestamp > 0 ? Date.now() - speechStartTimestamp : 0;
  // In continuous Voice Mode use responsive adaptive endpointing (700–1950ms).
  // In one-shot dictation without live interim text, preserve the 2.4s fallback window.
  const endpointWindowMs =
    !currentContinuousMode && !liveText.trim()
      ? 2400
      : computeAdaptiveEndpointMs(liveText, speechDurationMs);
  lastSilenceWindowMs = endpointWindowMs;

  silenceTimer = setTimeout(() => {
    if (isSessionActive && hasDetectedSpeech) {
      voiceTurnArbitrator.transition('endpointing');
      try {
        emitTrace({
          turnId: currentTurnTraceId,
          ev: 'vad.eos',
          silenceWindowMs: endpointWindowMs,
          speechDurationMs: speechStartTimestamp > 0 ? Date.now() - speechStartTimestamp : 0,
        });
      } catch {}
      void stopOperatorListening();
    }
  }, endpointWindowMs);
}

async function ensureAudioGraphOpen(deviceId?: string | null, suppressCue = false): Promise<void> {
  const hasLiveStream =
    activeMediaStream &&
    activeMediaStream.getAudioTracks().some((t) => t.readyState === 'live');
  if (hasLiveStream && activeAudioContext && activeAudioContext.state !== 'closed') {
    if (activeAudioContext.state === 'suspended') {
      try {
        await activeAudioContext.resume();
      } catch {}
    }
    return;
  }

  const stream = await getAudioInputStream(deviceId);
  if (!isSessionActive && !isPersistentGraphActive) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }
  activeMediaStream = stream;
  await startAudioDucking({ suppressCue });

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
      preRollBuffer = new PcmPreRollBuffer(audioSampleRate, 400);
      if (!isSpeechCaptureOpen) {
        preConnectBuffer.reset(audioSampleRate);
      }
      const source = activeAudioContext.createMediaStreamSource(stream);
      const analyser = activeAudioContext.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      activeAnalyser = analyser;

      let workletAttached = false;
      if (
        typeof AudioWorkletNode !== 'undefined' &&
        activeAudioContext.audioWorklet &&
        typeof activeAudioContext.audioWorklet.addModule === 'function' &&
        typeof URL !== 'undefined' &&
        typeof URL.createObjectURL === 'function'
      ) {
        try {
          const blob = new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' });
          activeWorkletUrl = URL.createObjectURL(blob);
          await activeAudioContext.audioWorklet.addModule(activeWorkletUrl);
          if (activeAudioContext && activeAudioContext.state !== 'closed') {
            const worklet = new AudioWorkletNode(activeAudioContext, PCM_WORKLET_PROCESSOR_NAME);
            worklet.port.onmessage = (ev: MessageEvent) => {
              const samples = ev.data;
              if (samples instanceof Float32Array) {
                handlePcmFrame(samples);
              }
            };
            source.connect(worklet);
            if (typeof activeAudioContext.createGain === 'function') {
              const silentGain = activeAudioContext.createGain();
              silentGain.gain.value = 0;
              worklet.connect(silentGain);
              silentGain.connect(activeAudioContext.destination);
              activeSilentGain = silentGain;
            }
            activeWorkletNode = worklet;
            workletAttached = true;
          }
        } catch {
          workletAttached = false;
        }
      }

      if (!workletAttached) {
        // Fallback to ScriptProcessorNode (zero-gain sink prevents speaker feedback)
        try {
          const processor = activeAudioContext.createScriptProcessor(4096, 1, 1);
          processor.onaudioprocess = (e) => {
            const input = e.inputBuffer.getChannelData(0);
            handlePcmFrame(input);
          };
          source.connect(processor);
          if (typeof activeAudioContext.createGain === 'function') {
            const silentGain = activeAudioContext.createGain();
            silentGain.gain.value = 0;
            processor.connect(silentGain);
            silentGain.connect(activeAudioContext.destination);
            activeSilentGain = silentGain;
          }
          activeProcessor = processor;
        } catch {}
      }
    } catch {}
  }
}

function teardownActiveRecognition(mode: 'stop' | 'abort' = 'abort'): void {
  if (recognitionRestartTimer) {
    clearTimeout(recognitionRestartTimer);
    recognitionRestartTimer = null;
  }
  const rec = activeRecognition;
  activeRecognition = null;
  if (!rec) return;
  try {
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    if (mode === 'abort' && typeof rec.abort === 'function') {
      rec.abort();
    } else if (typeof rec.stop === 'function') {
      rec.stop();
    } else if (typeof rec.abort === 'function') {
      rec.abort();
    }
  } catch {
    try {
      if (typeof rec.stop === 'function') rec.stop();
    } catch {}
  }
}

function createAndStartRecognition(
  SpeechImpl: any,
  options: StartListeningOptions,
  epoch: number,
  isRetry: boolean = false
): void {
  if (!isSessionActive || epoch !== recognitionEpoch) return;
  const recognition = new SpeechImpl();
  recognition.lang = options.language || 'es-ES';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event: any) => {
    if (!isSessionActive || epoch !== recognitionEpoch || activeRecognition !== recognition) {
      return;
    }
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
      if (!speechStartTimestamp) {
        speechStartTimestamp = Date.now();
      }
      openSpeechPcmCapture();
      if (currentText !== lastRecognizedText) {
        lastRecognizedText = currentText;
        trailingSilenceSamples = 0;
      }
      resetSilenceTimer();
      speculativePreCapture.update(currentText);
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
    if (activeRecognition !== recognition) return;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    activeRecognition = null;

    currentSpeechTranscript = joinSpeechPartial(currentSpeechTranscript, lastInterimTranscript);
    lastInterimTranscript = '';
    if (currentSpeechTranscript && options.onInterim) {
      options.onInterim(currentSpeechTranscript);
    }
    if (isSessionActive && epoch === recognitionEpoch) {
      try {
        createAndStartRecognition(SpeechImpl, options, epoch, false);
      } catch {}
    }
  };

  activeRecognition = recognition;
  try {
    recognition.start();
  } catch (err: any) {
    const errName = err?.name || '';
    const errMsg = String(err?.message || err || '');
    if (
      !isRetry &&
      (errName === 'InvalidStateError' || /InvalidStateError|already started/i.test(errMsg))
    ) {
      if (recognitionRestartTimer) {
        clearTimeout(recognitionRestartTimer);
      }
      recognitionRestartTimer = setTimeout(() => {
        recognitionRestartTimer = null;
        if (!isSessionActive || epoch !== recognitionEpoch) return;
        teardownActiveRecognition('abort');
        try {
          createAndStartRecognition(SpeechImpl, options, epoch, true);
        } catch (retryErr) {
          console.warn('[ZedVoice] SpeechRecognition retry warning:', retryErr);
        }
      }, 60);
    } else {
      console.warn('[ZedVoice] SpeechRecognition start warning:', err);
    }
  }
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

  disarmBargeInMonitor();
  const reuseGraph = Boolean(
    options.continuous && (nativeStreamWarm || (activeMediaStream && activeAudioContext))
  );

  // Drop any stale capture promise without tearing down a warm persistent session graph.
  await stopOperatorListening({ discard: true, keepAudioGraph: reuseGraph });

  currentOptions = options;
  currentContinuousMode = Boolean(options.continuous);
  isPersistentGraphActive = currentContinuousMode;
  currentRecordedChunks = [];
  streamingSttTranscript = '';
  if (options.fromBargeIn) {
    preConnectBuffer.clear();
    if (preConnectBuffer.getState() === 'buffering') {
      preConnectBuffer.releaseAndDrain();
    }
    rawPcmChunks = preRollBuffer.drain();
    isSpeechCaptureOpen = true;
    hasVadVoicedFrame = true;
  } else {
    preRollBuffer.clear();
    preConnectBuffer.reset(audioSampleRate);
    wsHandshakeBuffer?.clear();
    wsHandshakeBuffer = null;
    rawPcmChunks = [];
    isSpeechCaptureOpen = false;
    hasVadVoicedFrame = false;
  }
  trailingSilenceSamples = 0;
  lastRecognizedText = '';
  currentSpeechTranscript = '';
  lastInterimTranscript = '';
  hasDetectedSpeech = Boolean(options.fromBargeIn);
  speechStartTimestamp = options.fromBargeIn ? Date.now() : 0;
  currentTurnTraceId = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  adaptiveVad.resetTurn(true);
  clearVadTimers();
  isSessionActive = true;
  lastNativeLevelTs = 0;
  const turnRecognitionEpoch = ++recognitionEpoch;
  recordingStartTime = Date.now();
  voiceTurnArbitrator.transition(options.fromBargeIn ? 'user_speaking' : 'listening');
  if (options.fromBargeIn) {
    if (!isNativeRustAudioSupported()) {
      startStreamingSttIfConfigured(rawPcmChunks);
    }
    resetSilenceTimer();
  } else {
    armNoSpeechTimer();
  }

  startingPromise = (async () => {
    // 0. Prefer native Rust cpal WASAPI capture when running inside Tauri desktop builds
    if (isNativeRustAudioSupported()) {
      let preferredDeviceId = options.deviceId ?? null;
      if (!preferredDeviceId && typeof localStorage !== 'undefined') {
        try {
          preferredDeviceId = localStorage.getItem('kite_selected_mic_device_id') || null;
        } catch {}
      }
      const subscribedThisStart = !nativeEventUnsub;
      if (!nativeEventUnsub) {
        nativeEventUnsub = await subscribeNativeAudioEvents({
          onAudioLevel: (lvl, rms, durationMs) => handleNativeAudioLevel(lvl, rms, durationMs),
          onSttPartial: (txt) => {
            if (!isSessionActive) return;
            const clean = txt.trim();
            if (!clean) return;
            streamingSttTranscript = clean;
            hasDetectedSpeech = true;
            if (!speechStartTimestamp) speechStartTimestamp = Date.now();
            resetSilenceTimer();
            speculativePreCapture.update(clean);
            currentOptions.onInterim?.(clean);
          },
          onSttFinal: (txt) => {
            if (!isSessionActive) return;
            const clean = txt.trim();
            if (!clean) return;
            streamingSttTranscript = clean;
            lastRecognizedText = clean;
            resetSilenceTimer();
            speculativePreCapture.update(clean);
            currentOptions.onInterim?.(clean);
          },
          onDeviceLost: (err) => {
            console.warn('[ArgosVoice] Native audio device warning:', err);
          },
        });
      }

      const { grokKey, grokBaseUrl } = resolveGrokSttConfigSync();
      const keepExistingNative = Boolean(
        options.continuous &&
          nativeStreamWarm &&
          (preferredDeviceId ?? null) === nativeDevicePref
      );
      const nativeStart = await startNativeAudioCapture({
        deviceId: preferredDeviceId,
        sampleRate: 16000,
        keepExisting: keepExistingNative,
        fromBargeIn: Boolean(options.fromBargeIn),
        sttApiKey: grokKey.trim() || undefined,
        sttBaseUrl: grokKey.trim() ? grokBaseUrl : undefined,
        sttLanguage: options.language || 'es-ES',
      });

      if (nativeStart.ok && isSessionActive) {
        nativeCaptureActive = true;
        nativeStreamWarm = true;
        nativeDevicePref = preferredDeviceId ?? null;
        audioSampleRate = 16000;
        await startAudioDucking({ suppressCue: reuseGraph });
        if (options.fromBargeIn) {
          isSpeechCaptureOpen = true;
          void markNativeSpeechStart(400);
        }
      } else {
        if (!nativeStart.ok) {
          console.warn(
            '[ArgosVoice] Native WASAPI capture unavailable, falling back to AudioWorklet:',
            nativeStart.error
          );
          nativeStreamWarm = false;
          nativeDevicePref = null;
          if (subscribedThisStart && nativeEventUnsub) {
            try {
              nativeEventUnsub();
            } catch {}
            nativeEventUnsub = null;
          }
        } else if (!isSessionActive) {
          if (!isPersistentGraphActive) {
            nativeStreamWarm = false;
            nativeDevicePref = null;
            void stopNativeAudioCapture({ keepAlive: false, discard: true });
            if (subscribedThisStart && nativeEventUnsub) {
              try {
                nativeEventUnsub();
              } catch {}
              nativeEventUnsub = null;
            }
          }
          return;
        }
      }
    }

    // 1. Open or reuse WebView2 microphone stream + AudioWorklet/Analyser (fallback or browser preview)
    if (!nativeCaptureActive && typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function') {
      try {
        await ensureAudioGraphOpen(options.deviceId, reuseGraph);
        if (!isSessionActive) {
          if (!isPersistentGraphActive) {
            stopAudioAnalysis();
          }
          return;
        }

        // Only run MediaRecorder as a fallback when Web Audio PCM capture did not attach,
        // avoiding redundant background WebM encoding during idle silence.
        const hasPcmCapture = Boolean(activeWorkletNode || activeProcessor);
        if (activeMediaStream && !hasPcmCapture && typeof MediaRecorder !== 'undefined') {
          try {
            const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
              ? 'audio/webm;codecs=opus'
              : MediaRecorder.isTypeSupported('audio/webm')
              ? 'audio/webm'
              : MediaRecorder.isTypeSupported('audio/mp4')
              ? 'audio/mp4'
              : '';
            const recorder = mime
              ? new MediaRecorder(activeMediaStream, { mimeType: mime })
              : new MediaRecorder(activeMediaStream);
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

    // 2. Start SpeechRecognition only as browser-preview/fallback when native Rust capture is inactive
    const SpeechImpl = !nativeCaptureActive ? getSpeechRecognitionImpl() : null;
    if (SpeechImpl && isSessionActive && turnRecognitionEpoch === recognitionEpoch) {
      try {
        createAndStartRecognition(SpeechImpl, options, turnRecognitionEpoch, false);
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
export async function stopOperatorListening(options?: {
  discard?: boolean;
  keepAudioGraph?: boolean;
}): Promise<string> {
  const discard = options?.discard === true;
  const keepGraph =
    options?.keepAudioGraph ?? (isPersistentGraphActive && !discard);
  clearVadTimers();
  const speechDetectedBeforeStop = hasDetectedSpeech;
  const wasFromBargeIn = Boolean(currentOptions.fromBargeIn);

  if (startingPromise) {
    try {
      await startingPromise;
    } catch {}
  }

  const wasRecording = isSessionActive;

  isSessionActive = false;
  recognitionEpoch += 1;
  const streamingSession = activeStreamingStt;
  activeStreamingStt = null;
  const activeWsHandshakeBuffer = wsHandshakeBuffer;
  wsHandshakeBuffer = null;
  const cachedStreamingTranscript = streamingSttTranscript.trim();
  streamingSttTranscript = '';

  const speechWasDetected = speechDetectedBeforeStop || hasDetectedSpeech;
  const wasVadVoiced = hasVadVoicedFrame;
  const trailingSilenceToInspect = trailingSilenceSamples;
  hasDetectedSpeech = false;
  isSpeechCaptureOpen = false;
  hasVadVoicedFrame = false;
  trailingSilenceSamples = 0;
  lastRecognizedText = '';
  const promise = currentSessionPromise;
  currentSessionPromise = null;

  const wasNativeCapture = nativeCaptureActive;
  const keepNativeWarm = Boolean(keepGraph && wasNativeCapture);
  nativeCaptureActive = false;
  if (!keepNativeWarm) {
    nativeStreamWarm = false;
    nativeDevicePref = null;
    if (nativeEventUnsub) {
      try {
        nativeEventUnsub();
      } catch {}
      nativeEventUnsub = null;
    }
  }

  if (discard) {
    if (wasNativeCapture) {
      void stopNativeAudioCapture({ keepAlive: keepNativeWarm, discard: true });
    }
    currentOptions = {};
    activeWsHandshakeBuffer?.clear();
    preConnectBuffer.clear();
    if (streamingSession) {
      streamingSession.abort();
    }
    teardownActiveRecognition('abort');
    if (activeMediaRecorder && activeMediaRecorder.state !== 'inactive') {
      try {
        activeMediaRecorder.stop();
      } catch {
        // ignore
      }
    }
    activeMediaRecorder = null;
    if (!keepGraph) {
      isPersistentGraphActive = false;
      stopAudioAnalysis();
      void stopAudioDucking();
    } else {
      rawPcmChunks = [];
    }
    currentRecordedChunks = [];
    if (promise) promise.resolve('');
    return '';
  }

  if (wasRecording) {
    currentOptions.onTranscribing?.();
  }

  if (!keepGraph) {
    void stopAudioDucking();
  }

  // 1. Stop SpeechRecognition cleanly with handler detachment
  teardownActiveRecognition('stop');

  const localTranscript = joinSpeechPartial(currentSpeechTranscript, lastInterimTranscript).trim();
  let hasSpeechPayload =
    speechWasDetected || Boolean(localTranscript) || Boolean(cachedStreamingTranscript);

  // 2. Prioritize already-captured PCM WAV, trimming dead trailing endpointing silence
  //    while retaining a ~250ms acoustic decay pad so closing consonants are never clipped.
  let audioBlob: Blob | null = null;
  let nativeSttTranscript = '';
  const trailingPadSamples = Math.round((audioSampleRate * TRAILING_SILENCE_PAD_MS) / 1000);
  const samplesToTrim =
    wasVadVoiced && trailingSilenceToInspect > trailingPadSamples
      ? trailingSilenceToInspect - trailingPadSamples
      : 0;
  const trimTrailingMs = Math.max(
    0,
    Math.round((samplesToTrim / Math.max(8000, audioSampleRate)) * 1000)
  );
  const effectivePcmChunks =
    samplesToTrim > 0 ? trimTrailingPcmSamples(rawPcmChunks, samplesToTrim) : rawPcmChunks;
  const totalPcmSamples = effectivePcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (wasNativeCapture) {
    try {
      const nativeStop = await stopNativeAudioCapture({
        keepAlive: keepNativeWarm,
        discard: false,
        trimTrailingMs,
      });
      nativeSttTranscript = (nativeStop.sttTranscript || '').trim();
      if (nativeStop.ok && nativeStop.wavBase64) {
        audioBlob = decodeWavBase64ToBlob(nativeStop.wavBase64);
      }
      if (nativeSttTranscript) {
        hasSpeechPayload = true;
      } else if (!currentContinuousMode && audioBlob && audioBlob.size > 1200) {
        hasSpeechPayload = true;
      }
    } catch (e) {
      console.warn('[ZedVoice] stopNativeAudioCapture error:', e);
    }
  }
  if (!audioBlob && hasSpeechPayload && totalPcmSamples > 0) {
    try {
      audioBlob = encodeWavBlob(effectivePcmChunks, audioSampleRate);
    } catch (e) {
      console.warn('[ZedVoice] encodeWavBlob error:', e);
    }
  }

  // Stop MediaRecorder: await onstop only if we actually need its fallback chunks.
  if (activeMediaRecorder && activeMediaRecorder.state !== 'inactive') {
    if (!hasSpeechPayload || (audioBlob && audioBlob.size > 200)) {
      try {
        activeMediaRecorder.onstop = null;
        activeMediaRecorder.stop();
      } catch {}
    } else {
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
    }
    activeMediaRecorder = null;
  }

  // Dual recording fallback: If raw PCM was empty, use MediaRecorder chunks
  if (hasSpeechPayload && !audioBlob && currentRecordedChunks.length > 0) {
    const candidate = new Blob(currentRecordedChunks, {
      type: currentRecordedChunks[0]?.type || 'audio/webm',
    });
    if (candidate.size > 200) {
      audioBlob = candidate;
    }
  }

  // 3. Release audio stream only when NOT in a warm persistent session
  if (!keepGraph) {
    isPersistentGraphActive = false;
    stopAudioAnalysis();
  } else {
    rawPcmChunks = [];
    preConnectBuffer.reset(audioSampleRate);
  }
  activeWsHandshakeBuffer?.clear();

  // 4. Resolve transcription (prefer cloud STT when speech was detected; fall back to Web Speech transcript cleanly)
  let finalText = '';
  let lastError = '';
  const capturedAudioMs =
    totalPcmSamples > 0
      ? Math.round((totalPcmSamples / Math.max(8000, audioSampleRate)) * 1000)
      : speechStartTimestamp > 0
        ? Math.max(0, Date.now() - speechStartTimestamp)
        : Math.max(0, Date.now() - recordingStartTime);
  const durationSecs = Math.max(0.5, capturedAudioMs / 1000);
  const sttStartTs = Date.now();
  let sttBackend = 'local';

  if (hasSpeechPayload) {
    if (nativeSttTranscript) {
      sttBackend = 'rust-ws';
      finalText = nativeSttTranscript;
    } else if (streamingSession && streamingSession.isOpen() && !streamingSession.hasFailed()) {
      sttBackend = 'grok-ws';
      try {
        emitTrace({
          turnId: currentTurnTraceId,
          ev: 'stt.start',
          backend: sttBackend,
          audioDurationMs: capturedAudioMs > 0 ? capturedAudioMs : undefined,
        });
      } catch {}
      try {
        finalText = (await streamingSession.finish()).trim();
      } catch (err: any) {
        lastError = err?.message || 'Error en streaming STT';
      }
      if (!finalText) {
        streamingSession.abort();
      }
    } else if (streamingSession) {
      streamingSession.abort();
    }

    if (!finalText && audioBlob && audioBlob.size > 200) {
      sttBackend = 'cloud';
      try {
        emitTrace({
          turnId: currentTurnTraceId,
          ev: 'stt.start',
          backend: sttBackend,
          audioDurationMs: capturedAudioMs > 0 ? capturedAudioMs : undefined,
        });
      } catch {}
      try {
        finalText = await transcribeOperatorAudioBlob(audioBlob);
      } catch (err: any) {
        lastError = err?.message || 'Error en transcripción';
      }
    }

    // Fallback to streaming partial or local Web Speech transcript whenever cloud STT failed or returned empty
    if (!finalText && (localTranscript || cachedStreamingTranscript)) {
      finalText = localTranscript || cachedStreamingTranscript;
      sttBackend = localTranscript ? 'webspeech-fallback' : 'grok-ws-partial';
    }
  } else if (streamingSession) {
    streamingSession.abort();
  }

  // Drop hallucinated phrases from silence
  if (finalText) {
    finalText = cleanTranscriptionText(finalText, durationSecs);
  }

  if (finalText) {
    if (wasFromBargeIn) {
      bargeInGate.recordValidBargeIn();
    }
    try {
      emitTrace({
        turnId: currentTurnTraceId,
        ev: 'stt.end',
        backend: sttBackend,
        durationMs: Date.now() - sttStartTs,
        chars: finalText.length,
        fallback: sttBackend === 'webspeech-fallback',
      });
    } catch {}
  } else if (wasFromBargeIn) {
    bargeInGate.recordEmptyBargeIn();
  }

  if (!finalText) {
    const discardReason =
      !speechWasDetected && !localTranscript
        ? 'Silencio o sin voz detectada'
        : !audioBlob || audioBlob.size <= 200
          ? 'Grabación vacía o de duración mínima'
          : lastError
            ? `Fallo al transcribir: ${lastError}`
            : 'No se detectaron palabras legibles en el audio';

    try {
      const voiceTurnId = currentTurnTraceId || `voice-${Date.now()}`;
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

    // Only surface an error when real speech was attempted and no STT backend succeeded.
    // Pure silence / empty captures settle quietly without spamming error toasts.
    if (speechWasDetected && lastError && !localTranscript) {
      currentOptions.onError?.(lastError);
    } else if (speechWasDetected && audioBlob && audioBlob.size > 200 && !localTranscript && !wasFromBargeIn) {
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
  disarmBargeInMonitor();
  if (activeWorkletNode) {
    try {
      activeWorkletNode.port.onmessage = null;
      activeWorkletNode.disconnect();
    } catch {}
    activeWorkletNode = null;
  }
  if (activeWorkletUrl) {
    try {
      URL.revokeObjectURL(activeWorkletUrl);
    } catch {}
    activeWorkletUrl = null;
  }
  if (activeProcessor) {
    try {
      activeProcessor.disconnect();
    } catch {}
    activeProcessor = null;
  }
  if (activeSilentGain) {
    try {
      activeSilentGain.disconnect();
    } catch {}
    activeSilentGain = null;
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
  preRollBuffer.clear();
  preConnectBuffer.clear();
  wsHandshakeBuffer?.clear();
  wsHandshakeBuffer = null;
  stopCapturedStreams();
}

/**
 * Drops any microphone capture SETH/Zed still holds and restores ducked volume.
 * Used when listening fails, and when the assistant is closed, muted, or minimized.
 */
export async function releaseOperatorCapture(): Promise<void> {
  speculativePreCapture.reset();
  if (nativeCaptureActive || nativeStreamWarm) {
    nativeCaptureActive = false;
    nativeStreamWarm = false;
    nativeDevicePref = null;
    void stopNativeAudioCapture({ keepAlive: false, discard: true });
  }
  if (nativeEventUnsub) {
    try {
      nativeEventUnsub();
    } catch {}
    nativeEventUnsub = null;
  }
  isSessionActive = false;
  isPersistentGraphActive = false;
  currentContinuousMode = false;
  sessionMuted = false;
  recognitionEpoch += 1;
  hasDetectedSpeech = false;
  isSpeechCaptureOpen = false;
  hasVadVoicedFrame = false;
  trailingSilenceSamples = 0;
  lastRecognizedText = '';
  streamingSttTranscript = '';
  if (activeStreamingStt) {
    activeStreamingStt.abort();
    activeStreamingStt = null;
  }
  wsHandshakeBuffer?.clear();
  wsHandshakeBuffer = null;
  preConnectBuffer.clear();
  clearVadTimers();
  disarmBargeInMonitor();
  voiceTurnArbitrator.transition('idle');
  teardownActiveRecognition('abort');
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

export function getLastAdaptiveSilenceWindowMs(): number {
  return lastSilenceWindowMs;
}
