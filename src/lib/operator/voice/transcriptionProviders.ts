import { isTauriEnvironment, proxyOperatorHttp } from '../../ipc';
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
