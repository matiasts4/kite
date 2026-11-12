import { isTauriEnvironment } from '../../ipc';
import { loadOperatorConfig, syncNativeCredentialsWithVault } from '../operatorConfig';
import { getAudioInputStream } from './audioDevices';
import { encodeWavBlob, cleanTranscriptionText } from './wavEncoder';
import { transcribeWithGrokCloud, transcribeWithCloudflareWhisper } from './transcriptionProviders';
import { getVoiceEngineStatus } from './voiceStatus';

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

      if (isTauriEnvironment()) {
        await syncNativeCredentialsWithVault().catch(() => undefined);
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
