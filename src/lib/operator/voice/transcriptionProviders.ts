import { isTauriEnvironment, proxyOperatorHttp } from '../../ipc';
import { blobToBase64 } from './wavEncoder';

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
