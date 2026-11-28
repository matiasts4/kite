import { isTauriEnvironment, proxyOperatorHttp } from '../../ipc';
import { joinSpeechPartial } from './speechPartial';
import { blobToBase64 } from './wavEncoder';

export type SttErrorCode =
  | 'MISSING_CREDENTIALS'
  | 'ENDPOINT_NOT_FOUND'
  | 'AUTH_ERROR'
  | 'PROVIDER_ERROR';

export class SttProviderError extends Error {
  readonly code: SttErrorCode;
  readonly status?: number;
  readonly fatal: boolean;

  constructor(code: SttErrorCode, message: string, status?: number, fatal = false) {
    super(message);
    this.name = 'SttProviderError';
    this.code = code;
    this.status = status;
    this.fatal = fatal;
  }
}

export function isFatalSttError(err: unknown): boolean {
  if (err instanceof SttProviderError) return err.fatal;
  const msg = typeof err === 'string' ? err : (err as Error)?.message || '';
  return /HTTP\s*(401|403|404)|ENDPOINT_NOT_FOUND|Falta configurar|Falta la API Key|Falta la cuenta|Permiso.*denegado|no está soportado|no está disponible/i.test(
    msg
  );
}

const cachedHealthySttEndpoint = new Map<string, string>();
const deadSttEndpoints = new Set<string>();

/** Clears the session-level STT endpoint health cache. Test-only. */
export function resetSttEndpointCacheForTests(): void {
  cachedHealthySttEndpoint.clear();
  deadSttEndpoints.clear();
}

function buildOrderedSttEndpoints(baseUrl: string, isXai: boolean, cacheKey: string): string[] {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const defaults = isXai
    ? [`${normalizedBase}/stt`, `${normalizedBase}/audio/transcriptions`]
    : [`${normalizedBase}/audio/transcriptions`];

  const preferred = cachedHealthySttEndpoint.get(cacheKey);
  const alive = defaults.filter((ep) => !deadSttEndpoints.has(ep));
  const pool = alive.length > 0 ? alive : defaults;

  if (preferred && pool.includes(preferred)) {
    return [preferred, ...pool.filter((ep) => ep !== preferred)];
  }
  return pool;
}

/**
 * Transcribes recorded audio blob using Grok / xAI transcription cloud endpoint.
 * Supports xAI native STT endpoint (/v1/stt with model grok-voice-transcribe-2.0)
 * as well as OpenAI / Groq compatible endpoints (/v1/audio/transcriptions).
 * Caches healthy/404 endpoints per session to avoid redundant round trips.
 * In desktop Tauri builds, proxies through Rust to bypass webview CORS restrictions.
 */
export async function transcribeWithGrokCloud(
  blob: Blob,
  apiKey: string,
  baseUrl: string = 'https://api.x.ai/v1',
  model: string = 'grok-voice-transcribe-2.0'
): Promise<string> {
  if (!apiKey || !apiKey.trim()) {
    throw new SttProviderError(
      'MISSING_CREDENTIALS',
      'Falta configurar la API Key de Grok (xAI) para la transcripción.',
      undefined,
      true
    );
  }

  const isXai = baseUrl.includes('api.x.ai') || (!baseUrl.includes('openai.com') && !baseUrl.includes('groq.com'));
  const effectiveModel = isXai && (!model || model === 'whisper-large-v3')
    ? 'grok-voice-transcribe-2.0'
    : (model || 'grok-voice-transcribe-2.0');

  const cacheKey = `${baseUrl.replace(/\/+$/, '')}::${effectiveModel}`;
  const candidateEndpoints = buildOrderedSttEndpoints(baseUrl, isXai, cacheKey);

  // If every candidate was already proven HTTP 404 in this session, fail fast with zero network wait.
  if (candidateEndpoints.every((ep) => deadSttEndpoints.has(ep))) {
    throw new SttProviderError(
      'ENDPOINT_NOT_FOUND',
      'El endpoint STT de Grok/xAI no está disponible (HTTP 404). Configura Cloudflare Whisper o usa el dictado nativo.',
      404,
      true
    );
  }

  let lastErrorMsg = '';
  let lastStatus = 0;

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
          cachedHealthySttEndpoint.set(cacheKey, endpoint);
          deadSttEndpoints.delete(endpoint);
          try {
            const json = JSON.parse(res.body || '{}');
            const resultText = json.text || (typeof json.result === 'string' ? json.result : json.result?.text) || '';
            if (resultText && resultText.trim().length > 0) {
              return resultText.trim();
            }
          } catch {}
        }

        lastStatus = res.status || 0;
        if (lastStatus === 404) {
          deadSttEndpoints.add(endpoint);
        }
        const snippet = (res.body || res.error || 'Fallo en la petición').slice(0, 160);
        lastErrorMsg = `HTTP ${lastStatus}: ${snippet}`;
        if (lastStatus === 401 || lastStatus === 403) {
          throw new SttProviderError(
            'AUTH_ERROR',
            `Credenciales de Grok STT rechazadas (HTTP ${lastStatus}).`,
            lastStatus,
            true
          );
        }
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
          cachedHealthySttEndpoint.set(cacheKey, endpoint);
          deadSttEndpoints.delete(endpoint);
          const json = (await response.json()) as any;
          const resultText = json.text || json.result?.text || '';
          if (resultText && resultText.trim().length > 0) {
            return resultText.trim();
          }
        }

        lastStatus = response.status;
        if (lastStatus === 404) {
          deadSttEndpoints.add(endpoint);
        }
        const errText = (await response.text().catch(() => '')).slice(0, 160);
        lastErrorMsg = `HTTP ${response.status}: ${errText || response.statusText}`;
        if (lastStatus === 401 || lastStatus === 403) {
          throw new SttProviderError(
            'AUTH_ERROR',
            `Credenciales de Grok STT rechazadas (HTTP ${lastStatus}).`,
            lastStatus,
            true
          );
        }
      }
    } catch (e: any) {
      if (e instanceof SttProviderError) throw e;
      lastErrorMsg = e?.message || String(e);
    }
  }

  if (lastStatus === 404) {
    throw new SttProviderError(
      'ENDPOINT_NOT_FOUND',
      'El endpoint STT de Grok/xAI no está disponible (HTTP 404). Configura Cloudflare Whisper o usa el dictado nativo.',
      404,
      true
    );
  }

  throw new SttProviderError(
    'PROVIDER_ERROR',
    `Grok Cloud error (${lastErrorMsg || 'Sin respuesta'})`,
    lastStatus || undefined,
    false
  );
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

export interface WebSocketLike {
  readyState: number;
  binaryType?: string;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketConstructorLike = new (
  url: string,
  protocols?: string | string[]
) => WebSocketLike;

export interface OpenGrokStreamingSttOptions {
  apiKey: string;
  baseUrl?: string;
  language?: string;
  endpointingMs?: number;
  handshakeTimeoutMs?: number;
  finishTimeoutMs?: number;
  WebSocketImpl?: WebSocketConstructorLike;
  onPartial?: (partial: string) => void;
  onFinal?: (finalText: string) => void;
  onError?: (error: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

export interface GrokStreamingSttSession {
  readonly url: string;
  isOpen(): boolean;
  hasFailed(): boolean;
  waitUntilReady(): Promise<boolean>;
  sendPcm16(int16Buffer: Int16Array): void;
  sendFloat32(samples: Float32Array, sampleRate?: number): void;
  getTranscript(): string;
  finish(): Promise<string>;
  abort(): void;
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 1200;
const DEFAULT_FINISH_TIMEOUT_MS = 1500;
const MAX_PENDING_PCM_CHUNKS = 120;

/**
 * Downsamples Float32 PCM audio to `targetRate` (16 kHz) and quantizes to signed 16-bit PCM.
 */
export function float32ToInt16Pcm(
  samples: Float32Array,
  sampleRate: number = 16000,
  targetRate: number = 16000
): Int16Array {
  if (!samples || samples.length === 0) {
    return new Int16Array(0);
  }
  let pcmData = samples;
  if (sampleRate > targetRate && targetRate > 0) {
    const ratio = sampleRate / targetRate;
    const newLen = Math.max(1, Math.round(samples.length / ratio));
    const downsampled = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const pos = i * ratio;
      const index = Math.floor(pos);
      const frac = pos - index;
      const next = index + 1 < samples.length ? samples[index + 1] : samples[samples.length - 1];
      downsampled[i] = samples[index] * (1 - frac) + next * frac;
    }
    pcmData = downsampled;
  }

  const out = new Int16Array(pcmData.length);
  for (let i = 0; i < pcmData.length; i++) {
    const clamped = Math.max(-1, Math.min(1, pcmData[i]));
    out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }
  return out;
}

/**
 * Derives the xAI streaming STT WebSocket URL from an HTTP(S) base URL.
 */
export function buildGrokSttWsUrl(
  baseUrl: string = 'https://api.x.ai/v1',
  language: string = 'es',
  endpointingMs: number = 400
): string {
  const trimmed = (baseUrl || 'https://api.x.ai/v1').trim().replace(/\/+$/, '');
  let wsBase = trimmed;
  if (/^https:\/\//i.test(wsBase)) {
    wsBase = `wss://${wsBase.slice('https://'.length)}`;
  } else if (/^http:\/\//i.test(wsBase)) {
    wsBase = `ws://${wsBase.slice('http://'.length)}`;
  } else if (!/^wss?:\/\//i.test(wsBase)) {
    wsBase = `wss://${wsBase}`;
  }

  const sttBase = wsBase.endsWith('/stt') ? wsBase : `${wsBase}/stt`;
  const shortLang = (language || 'es').split(/[-_]/)[0].trim().toLowerCase() || 'es';
  const params = new URLSearchParams({
    sample_rate: '16000',
    encoding: 'pcm',
    interim_results: 'true',
    language: shortLang,
    endpointing: String(Math.max(100, Math.round(endpointingMs))),
  });
  return `${sttBase}?${params.toString()}`;
}

function isValidWsSubprotocolToken(token: string): boolean {
  return Boolean(token) && /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/.test(token);
}

/**
 * Opens a live streaming STT WebSocket session against xAI `/v1/stt`.
 * Buffers initial PCM16 chunks during the <=1200ms handshake, emits interim/final transcripts,
 * sends `{"type":"audio.done"}` on `finish()`, and degrades cleanly to batch HTTP fallback on failure.
 */
export function openGrokStreamingSttSession(
  options: OpenGrokStreamingSttOptions
): GrokStreamingSttSession | null {
  const apiKey = (options.apiKey || '').trim();
  const baseUrl = (options.baseUrl || 'https://api.x.ai/v1').trim();
  const isXai =
    baseUrl.includes('api.x.ai') ||
    (!baseUrl.includes('openai.com') && !baseUrl.includes('groq.com'));
  if (!apiKey || !isXai) {
    return null;
  }

  const WebSocketCtor: WebSocketConstructorLike | undefined =
    options.WebSocketImpl ||
    (typeof globalThis !== 'undefined' && typeof (globalThis as any).WebSocket === 'function'
      ? ((globalThis as any).WebSocket as WebSocketConstructorLike)
      : undefined);
  if (!WebSocketCtor) {
    return null;
  }

  const url = buildGrokSttWsUrl(
    baseUrl,
    options.language || 'es',
    options.endpointingMs ?? 400
  );
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const finishTimeoutMs = options.finishTimeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS;

  let ws: WebSocketLike | null = null;
  let open = false;
  let failed = false;
  let aborted = false;
  let done = false;
  let finishSent = false;
  let finalTranscript = '';
  let interimTranscript = '';
  let pendingFrames: Int16Array[] = [];
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;

  let resolveReady: ((ok: boolean) => void) | null = null;
  const readyPromise = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });

  let resolveFinish: ((text: string) => void) | null = null;
  let finishPromise: Promise<string> | null = null;

  const clearTimers = () => {
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
    if (finishTimer) {
      clearTimeout(finishTimer);
      finishTimer = null;
    }
  };

  const settleReady = (ok: boolean) => {
    if (resolveReady) {
      const r = resolveReady;
      resolveReady = null;
      r(ok);
    }
  };

  const settleFinish = (text: string) => {
    if (finishTimer) {
      clearTimeout(finishTimer);
      finishTimer = null;
    }
    if (resolveFinish) {
      const r = resolveFinish;
      resolveFinish = null;
      r(text);
    }
  };

  const detachAndCloseSocket = () => {
    const socket = ws;
    ws = null;
    if (!socket) return;
    try {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      // Keep a no-op error handler while closing so CONNECTING sockets never throw unhandled error events.
      socket.onerror = () => {};
      if (socket.readyState === WS_CONNECTING || socket.readyState === WS_OPEN) {
        socket.close();
      }
    } catch {}
  };

  const failSession = (reason: string) => {
    if (aborted || failed) return;
    failed = true;
    open = false;
    pendingFrames = [];
    clearTimers();
    detachAndCloseSocket();
    settleReady(false);
    settleFinish('');
    try {
      options.onError?.(reason);
    } catch {}
  };

  const sendBinaryFrame = (socket: WebSocketLike, pcm: Int16Array) => {
    if (pcm.length === 0) return;
    const slice =
      pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength
        ? pcm.buffer
        : pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
    socket.send(slice as ArrayBuffer);
  };

  try {
    const subprotocols = isValidWsSubprotocolToken(apiKey)
      ? ['xai-client', `xai-api-key.${apiKey}`]
      : undefined;
    try {
      ws = subprotocols ? new WebSocketCtor(url, subprotocols) : new WebSocketCtor(url);
    } catch {
      const authUrl = `${url}&api_key=${encodeURIComponent(apiKey)}`;
      ws = new WebSocketCtor(authUrl);
    }
    if (ws) {
      ws.binaryType = 'arraybuffer';
    }
  } catch (err: any) {
    failed = true;
    settleReady(false);
    try {
      options.onError?.(err?.message || 'No se pudo iniciar WebSocket STT.');
    } catch {}
  }

  if (ws && !failed) {
    handshakeTimer = setTimeout(() => {
      if (!open && !aborted && !failed) {
        failSession(`Timeout de handshake WebSocket STT (${handshakeTimeoutMs}ms).`);
      }
    }, handshakeTimeoutMs);

    ws.onopen = () => {
      if (aborted || failed || !ws) return;
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
      open = true;
      settleReady(true);
      const queued = pendingFrames;
      pendingFrames = [];
      for (const frame of queued) {
        try {
          sendBinaryFrame(ws, frame);
        } catch (err: any) {
          failSession(err?.message || 'Error enviando PCM16 pre-roll por WebSocket.');
          return;
        }
      }
      try {
        options.onOpen?.();
      } catch {}
    };

    ws.onmessage = (event: any) => {
      if (aborted || failed) return;
      const rawData = event?.data;
      if (typeof rawData !== 'string') return;
      let payload: any;
      try {
        payload = JSON.parse(rawData);
      } catch {
        return;
      }
      if (!payload || typeof payload !== 'object') return;

      const msgType = String(payload.type || '');
      const textChunk = String(
        payload.transcript ??
          payload.text ??
          payload.delta ??
          payload.data?.transcript ??
          payload.channel?.alternatives?.[0]?.transcript ??
          ''
      ).trim();

      if (msgType === 'Error' || msgType === 'error') {
        const errMsg = String(
          payload.error?.message || payload.message || 'Error en streaming STT de Grok.'
        );
        failSession(errMsg);
        return;
      }

      if (
        msgType === 'Done' ||
        msgType === 'done' ||
        msgType === 'transcript.done' ||
        msgType === 'session.done'
      ) {
        if (textChunk) {
          finalTranscript = joinSpeechPartial(finalTranscript, textChunk);
        } else if (interimTranscript) {
          finalTranscript = joinSpeechPartial(finalTranscript, interimTranscript);
        }
        interimTranscript = '';
        done = true;
        const settled = finalTranscript.trim();
        detachAndCloseSocket();
        settleFinish(settled);
        return;
      }

      const isFinalSegment =
        payload.is_final === true ||
        payload.speech_final === true ||
        msgType === 'transcript.final';

      if (
        msgType === 'transcript.created' ||
        msgType === 'transcript.partial' ||
        msgType === 'transcript.final' ||
        msgType === 'interim' ||
        msgType === 'transcript' ||
        msgType === 'response.audio_transcript.delta' ||
        Boolean(textChunk)
      ) {
        if (!textChunk) return;
        if (isFinalSegment) {
          finalTranscript = joinSpeechPartial(finalTranscript, textChunk);
          interimTranscript = '';
          try {
            options.onFinal?.(finalTranscript);
            options.onPartial?.(finalTranscript);
          } catch {}
        } else {
          interimTranscript = textChunk;
          const combined = joinSpeechPartial(finalTranscript, interimTranscript);
          try {
            options.onPartial?.(combined);
          } catch {}
        }
      }
    };

    ws.onerror = () => {
      if (aborted || failed) return;
      failSession('Error de conexión en WebSocket STT.');
    };

    ws.onclose = () => {
      if (aborted) return;
      open = false;
      clearTimers();
      try {
        options.onClose?.();
      } catch {}
      if (!done && !finishSent) {
        failSession('WebSocket STT cerrado antes de completar.');
        return;
      }
      if (interimTranscript && !finalTranscript) {
        finalTranscript = interimTranscript.trim();
      }
      done = true;
      settleFinish(finalTranscript.trim());
    };
  }

  return {
    url,
    isOpen: () => open && !failed && !aborted,
    hasFailed: () => failed || aborted,
    waitUntilReady: () => readyPromise,
    sendPcm16(int16Buffer: Int16Array) {
      if (aborted || failed || finishSent || !int16Buffer || int16Buffer.length === 0) return;
      if (open && ws && ws.readyState === WS_OPEN) {
        try {
          sendBinaryFrame(ws, int16Buffer);
        } catch (err: any) {
          failSession(err?.message || 'Fallo al enviar PCM16.');
        }
        return;
      }
      if (pendingFrames.length < MAX_PENDING_PCM_CHUNKS) {
        pendingFrames.push(new Int16Array(int16Buffer));
      }
    },
    sendFloat32(samples: Float32Array, sampleRate: number = 16000) {
      if (aborted || failed || finishSent || !samples || samples.length === 0) return;
      const pcm16 = float32ToInt16Pcm(samples, sampleRate, 16000);
      this.sendPcm16(pcm16);
    },
    getTranscript() {
      return joinSpeechPartial(finalTranscript, interimTranscript).trim();
    },
    async finish(): Promise<string> {
      if (finishPromise) return finishPromise;
      finishSent = true;
      if (aborted || failed || !open || !ws || ws.readyState !== WS_OPEN) {
        const alreadyFinal = done ? finalTranscript.trim() : '';
        if (!alreadyFinal) {
          aborted = true;
          detachAndCloseSocket();
        }
        return alreadyFinal;
      }
      if (done) {
        detachAndCloseSocket();
        return finalTranscript.trim();
      }

      finishPromise = new Promise<string>((resolve) => {
        resolveFinish = resolve;
        finishTimer = setTimeout(() => {
          const fallbackCommitted = joinSpeechPartial(finalTranscript, interimTranscript).trim();
          done = true;
          detachAndCloseSocket();
          settleFinish(fallbackCommitted);
        }, finishTimeoutMs);

        try {
          ws!.send(JSON.stringify({ type: 'audio.done' }));
        } catch {
          failSession('No se pudo enviar audio.done al WebSocket STT.');
        }
      });

      return finishPromise;
    },
    abort() {
      if (aborted) return;
      aborted = true;
      failed = true;
      open = false;
      pendingFrames = [];
      clearTimers();
      detachAndCloseSocket();
      settleReady(false);
      settleFinish('');
    },
  };
}

export const streamTranscribeWithGrokWs = openGrokStreamingSttSession;
