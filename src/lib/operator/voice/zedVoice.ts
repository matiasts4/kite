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

import { loadOperatorConfig } from '../operatorConfig';
import { isTauriEnvironment, proxyOperatorHttp } from '../../ipc';
import { startAudioDucking, stopAudioDucking } from './audioDucking';

export interface VoiceEngineStatus {
  available: boolean;
  engine: 'grok-cloud' | 'cloudflare-cloud' | 'browser' | 'none';
  label: string;
  detail: string;
  hasGrokApiKey: boolean;
}

export interface AudioInputDeviceInfo {
  deviceId: string;
  label: string;
  groupId?: string;
}

function getSpeechRecognitionImpl(): any {
  if (typeof window === 'undefined') return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

export function isVoiceRecognitionSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const hasMediaDevices = Boolean(
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
  return hasMediaDevices || getSpeechRecognitionImpl() !== null;
}

export function getVoiceEngineStatus(): VoiceEngineStatus {
  let grokKey = '';
  try {
    const config = loadOperatorConfig();
    grokKey = config.grokTranscriptionApiKey || config.grokApiKey || '';
    if (!grokKey && typeof localStorage !== 'undefined') {
      grokKey = localStorage.getItem('kite_grok_transcription_api_key') || '';
    }
  } catch {
    // ignore
  }

  const hasGrokApiKey = Boolean(grokKey && grokKey.trim().length > 0);

  if (hasGrokApiKey) {
    return {
      available: true,
      engine: 'grok-cloud',
      label: 'Grok Cloud Speech (xAI / Nube)',
      detail: 'Transcripción ultrarrápida en la nube con modelos Grok Whisper de alta fidelidad.',
      hasGrokApiKey: true,
    };
  }

  let hasCloudflare = false;
  try {
    const config = loadOperatorConfig();
    hasCloudflare = Boolean(config.cloudflareAccountId?.trim() && config.cloudflareApiToken?.trim());
  } catch {
    hasCloudflare = false;
  }

  if (hasCloudflare) {
    return {
      available: true,
      engine: 'cloudflare-cloud',
      label: 'Cloud Whisper (Cloudflare)',
      detail: 'Transcripción en la nube con la cuenta de Cloudflare guardada en Ajustes.',
      hasGrokApiKey: false,
    };
  }

  return {
    available: false,
    engine: 'none',
    label: 'Sin clave de transcripción',
    detail: 'Falta el token de Cloudflare o la clave de Grok en Ajustes de Zed. No hay una clave escrita en el programa.',
    hasGrokApiKey: false,
  };
}

/**
 * Enumerate connected audio input devices (microphones)
 */
export async function listAudioInputDevices(): Promise<AudioInputDeviceInfo[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return [];
  }
  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    let audioInputs = devices.filter((d) => d.kind === 'audioinput');

    // If permission has not been requested yet in this window session,
    // device labels will be empty strings. In that case, request a temporary
    // stream to unlock hardware labels, then stop it immediately.
    const hasMissingLabels = audioInputs.length > 0 && !audioInputs[0].label;
    if (hasMissingLabels && typeof navigator.mediaDevices.getUserMedia === 'function') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
        audioInputs = devices.filter((d) => d.kind === 'audioinput');
      } catch (err) {
        console.warn('[ZedVoice] No se pudo obtener permiso temporal para etiquetas:', err);
      }
    }

    return audioInputs.map((d, idx) => ({
      deviceId: d.deviceId,
      label: d.label || `Micrófono ${idx + 1}`,
      groupId: d.groupId,
    }));
  } catch (err) {
    console.warn('[ZedVoice] Error al enumerar micrófonos:', err);
    return [];
  }
}

export interface MicrophoneTester {
  stop: () => void;
}

/**
 * Starts a live microphone test that reads real-time volume levels (0 to 1)
 * from the selected device, perfect for VU meters in Settings.
 */
export async function startMicrophoneTest(
  deviceId: string | null,
  onLevel: (level: number) => void
): Promise<MicrophoneTester> {
  const stream = await getAudioInputStream(deviceId);
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextClass) {
    return {
      stop: () => {
        stream.getTracks().forEach((t) => t.stop());
        onLevel(0);
      },
    };
  }

  const audioCtx = new AudioContextClass();
  if (audioCtx.state === 'suspended') {
    try {
      await audioCtx.resume();
    } catch {}
  }
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 64;
  analyser.smoothingTimeConstant = 0.3;
  source.connect(analyser);

  let active = true;
  let rafId: number | null = null;
  const buffer = new Uint8Array(analyser.frequencyBinCount);

  const loop = () => {
    if (!active) return;
    analyser.getByteFrequencyData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      sum += buffer[i];
    }
    const avg = sum / buffer.length / 255;
    const level = Math.min(1, avg * 2.5);
    onLevel(level);
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);

  return {
    stop: () => {
      active = false;
      if (rafId) cancelAnimationFrame(rafId);
      try {
        source.disconnect();
        analyser.disconnect();
        audioCtx.close();
      } catch {}
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch {}
      onLevel(0);
    },
  };
}

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

const WHISPER_SILENCE_HALLUCINATIONS = [
  'gracias',
  'muchas gracias',
  'gracias por ver',
  'gracias por su atención',
  'gracias por su atencion',
  'gracias por escuchar',
  'thank you',
  'thanks',
  'thank you for watching',
  'thanks for watching',
  "i'm sorry",
  'im sorry',
  'subtítulos por la comunidad de amara.org',
  'subtítulos realizados por la comunidad de amara.org',
  'subtitulos por la comunidad de amara.org',
  'subtítulos por',
  'subtitulos por',
  'ご視聴ありがとうございました',
  'ご視聴ありがとう',
  'ありがとうございました',
  'チャンネル登録',
  'おやすみなさい',
  'bye bye',
  'bye',
];

const CJK_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;

/**
 * Cleans Whisper / STT silence and non-speech hallucinations
 * so short silence does not become a fake phrase.
 */
export function cleanTranscriptionText(text: string, durationSecs: number = 0): string {
  let normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';

  // In Spanish/English dictation mode, any CJK output from Whisper is guaranteed to be a silence hallucination
  if (CJK_REGEX.test(normalized)) {
    return '';
  }

  const lowered = normalized.toLowerCase().replace(/^[.,!?:;¡!¿?"'`[\]()]*(.*?)[.,!?:;¡!¿?"'`[\]()]*$/, '$1').trim();

  // If text matches any Whisper silence hallucination, drop it immediately
  if (WHISPER_SILENCE_HALLUCINATIONS.some((h) => lowered === h || lowered.startsWith(h) || lowered.endsWith(h))) {
    return '';
  }

  // Check if string is a repetitive loop hallucination like "I'm sorry, I'm sorry, I'm sorry..."
  const words = normalized.split(/\s+/);
  if (words.length >= 6) {
    const firstTwo = `${words[0]} ${words[1]}`.toLowerCase();
    const secondTwo = `${words[2]} ${words[3]}`.toLowerCase();
    const thirdTwo = `${words[4]} ${words[5]}`.toLowerCase();
    if (firstTwo === secondTwo && secondTwo === thirdTwo) {
      return '';
    }
  }

  // Strip gratitude suffixes or prefixes if present on medium-length recordings
  if (durationSecs <= 10.0) {
    for (const phrase of WHISPER_SILENCE_HALLUCINATIONS) {
      const prefixRegex = new RegExp(`^\\s*${phrase}[\\s.,;:!\\?¡¿-]+`, 'i');
      const suffixRegex = new RegExp(`[\\s.,;:!\\?¡¿-]+${phrase}\\s*$`, 'i');
      normalized = normalized.replace(prefixRegex, '').replace(suffixRegex, '').trim();
    }
  }

  // Strip leading hesitation filler words in spoken Spanish (e.g. "Eh, ", "Em, ", "Este, ", "Ah, ")
  normalized = normalized.replace(/^(?:eh|em|este|ah|bueno|oye)[,.\s]+/i, '').trim();

  return normalized;
}

/**
 * Converts a Blob to a base64 string using fast native FileReader or chunked fallback.
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        const comma = dataUrl.indexOf(',');
        resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
      };
      reader.onerror = () => reject(new Error('Fallo al leer datos de audio'));
      reader.readAsDataURL(blob);
    });
  }
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * Encodes an array of Float32 PCM sample chunks into a valid standard 16-bit PCM WAV Blob.
 * Includes DC offset removal, peak normalization, and 16 kHz mono linear downsampling.
 */
export function encodeWavBlob(
  samples: Float32Array[],
  sampleRate: number,
  targetRate: number = 16000
): Blob {
  let totalLength = 0;
  for (const chunk of samples) {
    totalLength += chunk.length;
  }
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of samples) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  // Downsample to 16kHz if needed (Whisper standard, cuts payload size ~3x)
  let pcmData = merged;
  let finalRate = sampleRate;
  if (sampleRate > targetRate && targetRate > 0 && merged.length > 0) {
    const ratio = sampleRate / targetRate;
    const newLen = Math.round(merged.length / ratio);
    const downsampled = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const pos = i * ratio;
      const index = Math.floor(pos);
      const frac = pos - index;
      const next = index + 1 < merged.length ? merged[index + 1] : merged[merged.length - 1];
      downsampled[i] = merged[index] * (1 - frac) + next * frac;
    }
    pcmData = downsampled;
    finalRate = targetRate;
  }

  // Pre-processing:
  // 1. Remove DC offset
  let sum = 0;
  for (let i = 0; i < pcmData.length; i++) {
    sum += pcmData[i];
  }
  const mean = pcmData.length > 0 ? sum / pcmData.length : 0;
  for (let i = 0; i < pcmData.length; i++) {
    pcmData[i] -= mean;
  }

  // 2. Peak normalization (boosts low-volume mic levels cleanly to ~0.95)
  let peak = 0;
  for (let i = 0; i < pcmData.length; i++) {
    const abs = Math.abs(pcmData[i]);
    if (abs > peak) peak = abs;
  }
  if (peak > 0.005) {
    const scale = 0.95 / peak;
    for (let i = 0; i < pcmData.length; i++) {
      pcmData[i] *= scale;
    }
  }

  const dataSize = pcmData.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // 'RIFF' chunk descriptor
  view.setUint32(0, 0x52494646, false); // 'RIFF'
  view.setUint32(4, 36 + dataSize, true);
  view.setUint32(8, 0x57415645, false); // 'WAVE'

  // 'fmt ' sub-chunk
  view.setUint32(12, 0x666d7420, false); // 'fmt '
  view.setUint32(16, 16, true); // 16 for PCM
  view.setUint16(20, 1, true); // Linear PCM
  view.setUint16(22, 1, true); // Mono (1 channel)
  view.setUint32(24, finalRate, true);
  view.setUint32(28, finalRate * 2, true); // Byte rate (finalRate * 1 * 16/8)
  view.setUint16(32, 2, true); // Block align (1 * 16/8)
  view.setUint16(34, 16, true); // Bits per sample

  // 'data' sub-chunk
  view.setUint32(36, 0x64617461, false); // 'data'
  view.setUint32(40, dataSize, true);

  // Convert float PCM samples [-1.0, 1.0] to 16-bit signed integers
  let pcmOffset = 44;
  for (let i = 0; i < pcmData.length; i++) {
    const s = Math.max(-1, Math.min(1, pcmData[i]));
    const val = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(pcmOffset, val, true);
    pcmOffset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Transcribes recorded audio blob using Grok / xAI transcription cloud endpoint.
 * Supports xAI native STT endpoint (/v1/stt with model grok-voice-transcribe-2.0)
 * as well as OpenAI / Groq compatible endpoints (/v1/audio/transcriptions).
 * In desktop Tauri builds, proxies through Rust to bypass webview CORS restrictions.
 */
export async function transcribeWithGrokCloud(
  blob: Blob,
  apiKey: string,
  baseUrl: string = 'https://api.x.ai/v1',
  model: string = 'grok-voice-transcribe-2.0'
): Promise<string> {
  const isXai = baseUrl.includes('api.x.ai') || (!baseUrl.includes('openai.com') && !baseUrl.includes('groq.com'));
  const effectiveModel = isXai && (!model || model === 'whisper-large-v3')
    ? 'grok-voice-transcribe-2.0'
    : (model || 'grok-voice-transcribe-2.0');

  // Candidate endpoints in order of priority:
  // For xAI: /stt is primary official REST endpoint, followed by /audio/transcriptions
  const candidateEndpoints: string[] = isXai
    ? [
        `${baseUrl.replace(/\/+$/, '')}/stt`,
        `${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`,
      ]
    : [`${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`];

  let lastErrorMsg = '';

  for (const endpoint of candidateEndpoints) {
    try {
      if (isTauriEnvironment()) {
        const audioBytes = await blob.arrayBuffer();
        const u8Audio = new Uint8Array(audioBytes);
        const boundary = `----KiteVoiceBoundary${Math.random().toString(36).substring(2)}`;
        const enc = new TextEncoder();

        const p1 = enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${effectiveModel}\r\n`);
        const p2 = enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nes\r\n`);
        const p3 = enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
        const p4 = enc.encode(`\r\n--${boundary}--\r\n`);

        const fullLen = p1.length + p2.length + p3.length + u8Audio.length + p4.length;
        const fullBody = new Uint8Array(fullLen);
        let off = 0;
        fullBody.set(p1, off); off += p1.length;
        fullBody.set(p2, off); off += p2.length;
        fullBody.set(p3, off); off += p3.length;
        fullBody.set(u8Audio, off); off += u8Audio.length;
        fullBody.set(p4, off);

        const fullBodyB64 = await blobToBase64(new Blob([fullBody]));

        const res = await proxyOperatorHttp({
          url: endpoint,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey.trim()}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          bodyBase64: fullBodyB64,
          timeoutSecs: 25,
        });

        if (res.success && res.status >= 200 && res.status < 300) {
          try {
            const json = JSON.parse(res.body || '{}');
            const resultText = json.text || (typeof json.result === 'string' ? json.result : json.result?.text) || '';
            if (resultText && resultText.trim().length > 0) {
              return resultText.trim();
            }
          } catch {}
        }

        lastErrorMsg = `HTTP ${res.status}: ${res.body || res.error || 'Fallo en la petición'}`;
      } else {
        // Web environment fallback
        const formData = new FormData();
        formData.append('file', blob, 'audio.wav');
        formData.append('model', effectiveModel);
        formData.append('language', 'es');

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey.trim()}`,
          },
          body: formData,
        });

        if (response.ok) {
          const json = (await response.json()) as any;
          const resultText = json.text || json.result?.text || '';
          if (resultText && resultText.trim().length > 0) {
            return resultText.trim();
          }
        }

        const errText = await response.text().catch(() => '');
        lastErrorMsg = `HTTP ${response.status}: ${errText || response.statusText}`;
      }
    } catch (e: any) {
      lastErrorMsg = e?.message || String(e);
    }
  }

  throw new Error(`Grok Cloud error (${lastErrorMsg || 'Sin respuesta'})`);
}

/**
 * Transcribes recorded audio blob using Cloudflare Whisper Cloud endpoint.
 * In desktop Tauri builds, proxies through Rust to bypass webview CORS restrictions.
 */
export async function transcribeWithCloudflareWhisper(
  blob: Blob,
  accountId: string = '',
  apiToken: string = ''
): Promise<string> {
  if (!accountId.trim() || !apiToken.trim()) {
    throw new Error(
      'Falta la cuenta o el token de Cloudflare en Ajustes de Zed. No hay una clave guardada en el programa.'
    );
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/openai/whisper`;

  if (isTauriEnvironment()) {
    const base64 = await blobToBase64(blob);
    const proxyRes = await proxyOperatorHttp({
      url,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken.trim()}`,
        'Content-Type': 'application/octet-stream',
      },
      bodyBase64: base64,
      timeoutSecs: 25,
    });

    if (!proxyRes.success || proxyRes.status < 200 || proxyRes.status >= 300) {
      throw new Error(`Cloudflare Whisper error (${proxyRes.status}): ${proxyRes.body || proxyRes.error || 'Fallo en la petición'}`);
    }

    try {
      const json = JSON.parse(proxyRes.body || '{}');
      return json.result?.text || '';
    } catch {
      throw new Error(`Respuesta inválida de Cloudflare Whisper: ${proxyRes.body?.slice(0, 100)}`);
    }
  }

  // Web environment fallback
  const arrayBuffer = await blob.arrayBuffer();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken.trim()}`,
      'Content-Type': 'application/octet-stream',
    },
    body: arrayBuffer,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Cloudflare Whisper error (${response.status}): ${errText}`);
  }

  const json = (await response.json()) as {
    result?: { text?: string };
    success?: boolean;
  };
  return json.result?.text || '';
}

const capturedStreams = new Set<MediaStream>();

function rememberStream(stream: MediaStream): MediaStream {
  capturedStreams.add(stream);
  return stream;
}

function stopCapturedStreams(): void {
  for (const stream of capturedStreams) {
    try {
      stream.getTracks().forEach((track) => track.stop());
    } catch {
      // ignore
    }
  }
  capturedStreams.clear();
}

export function describeMicrophoneError(err: unknown): string {
  const name = (err as { name?: string } | null)?.name || '';
  const message = String((err as { message?: string } | null)?.message || err || '');
  if (name === 'NotAllowedError' || /permission|denied|permiso/i.test(message)) {
    return 'Permiso de micrófono denegado en Windows.';
  }
  if (name === 'NotFoundError') {
    return 'No se detectó ningún micrófono conectado.';
  }
  if (
    name === 'NotReadableError' ||
    /device in use|in use|busy|could not start audio/i.test(message)
  ) {
    return 'El micrófono está ocupado. Solté la captura de Zed; si sigue así, cierra la otra ventana de Kite que lo tenga abierto.';
  }
  return 'No pude abrir el micrófono.';
}

function isDeviceInUse(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name || '';
  const message = String((err as { message?: string } | null)?.message || err || '');
  return name === 'NotReadableError' || /device in use|in use|could not start audio/i.test(message);
}

async function openMicrophone(constraints: MediaStreamConstraints): Promise<MediaStream> {
  try {
    return rememberStream(await navigator.mediaDevices.getUserMedia(constraints));
  } catch (err) {
    if (!isDeviceInUse(err)) throw err;
    stopCapturedStreams();
    await new Promise((resolve) => setTimeout(resolve, 180));
    try {
      return rememberStream(await navigator.mediaDevices.getUserMedia(constraints));
    } catch (retryErr) {
      throw new Error(describeMicrophoneError(retryErr));
    }
  }
}

/**
 * Gets audio input stream with default microphone auto-detection.
 */
export async function getAudioInputStream(preferredDeviceId?: string | null): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    throw new Error('El acceso al micrófono no está soportado en este entorno.');
  }

  let deviceIdToUse = preferredDeviceId;
  try {
    if (!deviceIdToUse && typeof localStorage !== 'undefined') {
      deviceIdToUse = localStorage.getItem('kite_selected_mic_device_id') || null;
    }
  } catch {}

  // 1. Try with preferred deviceId if provided
  if (deviceIdToUse && deviceIdToUse !== 'automatic' && deviceIdToUse !== 'default') {
    try {
      return await openMicrophone({
        audio: {
          deviceId: { ideal: deviceIdToUse },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      console.warn('[ZedVoice] Fallo con dispositivo específico, usando micrófono predeterminado:', e);
    }
  }

  // 2. Default system microphone with clean voice processing
  try {
    return await openMicrophone({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (e) {
    if (isDeviceInUse(e) || (e instanceof Error && /micrófono está ocupado/i.test(e.message))) {
      throw e instanceof Error ? e : new Error(describeMicrophoneError(e));
    }
    return await openMicrophone({ audio: true });
  }
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
  try {
    const config = loadOperatorConfig();
    grokKey = config.grokTranscriptionApiKey || config.grokApiKey || '';
    grokBaseUrl = config.grokTranscriptionBaseUrl || config.grokBaseUrl || 'https://api.x.ai/v1';
    grokModel = config.grokTranscriptionModel || 'grok-voice-transcribe-2.0';
    if (!grokKey && typeof localStorage !== 'undefined') {
      grokKey = localStorage.getItem('kite_grok_transcription_api_key') || '';
    }
  } catch {}

  if (grokKey && audioBlob.size > 200) {
    try {
      return await transcribeWithGrokCloud(audioBlob, grokKey, grokBaseUrl, grokModel);
    } catch (err) {
      console.warn('[ZedVoice] Grok Cloud avisó error, usando Cloudflare Whisper:', err);
    }
  }

  const config = loadOperatorConfig();
  const cfAccount = config.cloudflareAccountId || '';
  const cfToken = config.cloudflareApiToken || '';
  return transcribeWithCloudflareWhisper(audioBlob, cfAccount, cfToken);
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
              currentSpeechTranscript += (currentSpeechTranscript ? ' ' : '') + item[0].transcript;
            } else {
              interim += item[0].transcript;
            }
          }
          lastInterimTranscript = interim;
          const currentText = (interim || currentSpeechTranscript).trim();
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

  // Only a real stop of an open mic should leave "listening" and show transcription.
  if (wasRecording) {
    currentOptions.onTranscribing?.();
  }

  // Restore Windows system audio and play the Zen stop chime after 60ms
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

  // If still empty, check diagnostic reason without trapping into a scary permanent red error
  if (!finalText) {
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

export interface TranscriptionTestResult {
  success: boolean;
  text?: string;
  engine: string;
  latencyMs: number;
  durationSecs: number;
  error?: string;
}

export interface TranscriptionTestSession {
  stopAndTranscribe: () => Promise<TranscriptionTestResult>;
  cancel: () => void;
}

/**
 * Starts an interactive test recording session for Speech-to-Text in Settings.
 * Call `session.stopAndTranscribe()` to finalize recording and transcribe via cloud STT.
 */
export async function startTranscriptionTestSession(
  deviceId: string | null = null,
  onAudioLevel?: (level: number) => void
): Promise<TranscriptionTestSession> {
  const stream = await getAudioInputStream(deviceId);
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextClass) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('AudioContext no está soportado en este entorno.');
  }

  const audioCtx = new AudioContextClass();
  if (audioCtx.state === 'suspended') {
    try {
      await audioCtx.resume();
    } catch {}
  }

  const sampleRate = audioCtx.sampleRate || 16000;
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 64;
  source.connect(analyser);

  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  const pcmChunks: Float32Array[] = [];

  let active = true;
  let rafId: number | null = null;
  const levelBuf = new Uint8Array(analyser.frequencyBinCount);

  const levelLoop = () => {
    if (!active) return;
    analyser.getByteFrequencyData(levelBuf);
    let sum = 0;
    for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i];
    const avg = sum / levelBuf.length / 255;
    onAudioLevel?.(Math.min(1, avg * 2.5));
    rafId = requestAnimationFrame(levelLoop);
  };
  if (onAudioLevel) {
    rafId = requestAnimationFrame(levelLoop);
  }

  processor.onaudioprocess = (e) => {
    if (!active) return;
    const input = e.inputBuffer.getChannelData(0);
    pcmChunks.push(new Float32Array(input));
  };

  source.connect(processor);
  processor.connect(audioCtx.destination);

  const startTime = Date.now();

  const cleanup = () => {
    active = false;
    if (rafId) cancelAnimationFrame(rafId);
    try {
      processor.disconnect();
      analyser.disconnect();
      source.disconnect();
      audioCtx.close();
    } catch {}
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch {}
    onAudioLevel?.(0);
  };

  return {
    cancel: () => {
      cleanup();
    },
    stopAndTranscribe: async () => {
      cleanup();
      const durationSecs = Math.max(0.5, (Date.now() - startTime) / 1000);

      if (pcmChunks.length === 0) {
        return {
          success: false,
          error: 'No se capturó audio del micrófono. Verifica que el micrófono esté conectado.',
          engine: getVoiceEngineStatus().label,
          latencyMs: 0,
          durationSecs,
        };
      }

      const wavBlob = encodeWavBlob(pcmChunks, sampleRate);
      if (wavBlob.size <= 200) {
        return {
          success: false,
          error: 'El audio grabado es demasiado corto o está en silencio.',
          engine: getVoiceEngineStatus().label,
          latencyMs: 0,
          durationSecs,
        };
      }

      const engineStatus = getVoiceEngineStatus();
      const t0 = Date.now();

      try {
        if (engineStatus.hasGrokApiKey) {
          const config = loadOperatorConfig();
          const grokKey =
            config.grokTranscriptionApiKey ||
            config.grokApiKey ||
            localStorage.getItem('kite_grok_transcription_api_key') ||
            '';
          const baseUrl = config.grokTranscriptionBaseUrl || config.grokBaseUrl || 'https://api.x.ai/v1';
          const model = config.grokTranscriptionModel || 'grok-voice-transcribe-2.0';

          try {
            const rawText = await transcribeWithGrokCloud(wavBlob, grokKey, baseUrl, model);
            const text = cleanTranscriptionText(rawText, durationSecs);
            return {
              success: true,
              text: text.trim(),
              engine: 'xAI Grok STT (grok-voice-transcribe-2.0)',
              latencyMs: Date.now() - t0,
              durationSecs,
            };
          } catch (grokErr: any) {
            console.warn('[ZedVoice] Fallo Grok en test, probando Cloudflare Whisper:', grokErr);
            const cfAccount = config.cloudflareAccountId || '';
            const cfToken = config.cloudflareApiToken || '';
            const rawText = await transcribeWithCloudflareWhisper(wavBlob, cfAccount, cfToken);
            const text = cleanTranscriptionText(rawText, durationSecs);
            return {
              success: true,
              text: text.trim(),
              engine: 'Cloud Whisper (Respaldo por aviso en Grok)',
              latencyMs: Date.now() - t0,
              durationSecs,
            };
          }
        } else {
          const config = loadOperatorConfig();
          const cfAccount = config.cloudflareAccountId || '';
          const cfToken = config.cloudflareApiToken || '';
          const rawText = await transcribeWithCloudflareWhisper(wavBlob, cfAccount, cfToken);
          const text = cleanTranscriptionText(rawText, durationSecs);
          return {
            success: true,
            text: text.trim(),
            engine: 'Cloud Whisper (Cloudflare)',
            latencyMs: Date.now() - t0,
            durationSecs,
          };
        }
      } catch (err: any) {
        return {
          success: false,
          error: err?.message || 'Error al conectar con el servicio de transcripción.',
          engine: engineStatus.label,
          latencyMs: Date.now() - t0,
          durationSecs,
        };
      }
    },
  };
}
