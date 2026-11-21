import { isTauriEnvironment, invokeCommand } from '../../ipc';

export interface ProxyHttpResponse {
  success: boolean;
  status: number;
  body: string;
  latency_ms?: number;
  latencyMs?: number;
  error?: string | null;
}

export interface OperatorHttpFetchOptions {
  /**
   * Let the native proxy resolve the provider credential when the caller does
   * not have an explicit key. Currently used by OpenCode Go so the token never
   * has to be copied out of the OpenCode CLI store.
   */
  credentialProvider?: 'opencode';
}

interface StreamProxyEventPayload {
  kind: 'meta' | 'chunk' | 'done' | 'error' | 'aborted';
  status?: number;
  ok?: boolean;
  text?: string;
  error?: string;
  latencyMs?: number;
}

function serializeRequestInit(init?: RequestInit): {
  method: string;
  headersRecord: Record<string, string>;
  bodyStr: string | null;
} {
  const method = init?.method || 'GET';
  const headersRecord: Record<string, string> = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => {
        headersRecord[k] = v;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) {
        headersRecord[k] = v;
      }
    } else {
      Object.assign(headersRecord, init.headers);
    }
  }

  let bodyStr: string | null = null;
  if (typeof init?.body === 'string') {
    bodyStr = init.body;
  } else if (init?.body) {
    bodyStr = String(init.body);
  }

  return { method, headersRecord, bodyStr };
}

export async function operatorHttpFetch(
  url: string,
  init?: RequestInit,
  options?: OperatorHttpFetchOptions
): Promise<Response> {
  if (isTauriEnvironment()) {
    try {
      const { method, headersRecord, bodyStr } = serializeRequestInit(init);

      const proxyRes = await invokeCommand<ProxyHttpResponse>('proxy_operator_http', {
        url,
        method,
        headers: headersRecord,
        body: bodyStr,
        timeoutSecs: 60,
        ...(options?.credentialProvider
          ? { credentialProvider: options.credentialProvider }
          : {}),
      });

      if (proxyRes) {
        return new Response(proxyRes.body || '', {
          status: proxyRes.status || (proxyRes.success ? 200 : 500),
          statusText: proxyRes.error || (proxyRes.success ? 'OK' : 'Proxy Error'),
          headers: new Headers({
            'Content-Type': 'application/json',
            'X-Proxy-Latency-Ms': String(proxyRes.latencyMs ?? proxyRes.latency_ms ?? 0),
          }),
        });
      }
    } catch {
      // Fallback to standard fetch if proxy command encounters an issue
    }
  }

  return fetch(url, init);
}

/**
 * True streaming HTTP fetch for Tauri desktop builds.
 * Uses `proxy_operator_http_stream` (pooled reqwest::Client + incremental Tauri events)
 * to deliver SSE chunks into a native ReadableStream without buffering the full response.
 * Falls back cleanly to `operatorHttpFetch` outside Tauri or if native event listeners are unavailable.
 */
export async function operatorHttpStreamFetch(
  url: string,
  init?: RequestInit,
  options?: OperatorHttpFetchOptions
): Promise<Response> {
  if (!isTauriEnvironment() || typeof ReadableStream === 'undefined') {
    return operatorHttpFetch(url, init, options);
  }

  if (init?.signal?.aborted) {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  }

  let listenFn:
    | ((
        event: string,
        handler: (event: { payload: StreamProxyEventPayload }) => void
      ) => Promise<() => void>)
    | null = null;
  try {
    const eventMod = await import('@tauri-apps/api/event');
    if (typeof eventMod?.listen === 'function') {
      listenFn = eventMod.listen as any;
    }
  } catch {
    listenFn = null;
  }

  if (!listenFn) {
    return operatorHttpFetch(url, init, options);
  }

  const { method, headersRecord, bodyStr } = serializeRequestInit(init);
  const requestId = `op-stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const eventName = `operator:http-stream:${requestId}`;
  const encoder = new TextEncoder();

  let unlisten: (() => void) | null = null;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let metaResolved = false;

  const cleanup = () => {
    if (unlisten) {
      try {
        unlisten();
      } catch {}
      unlisten = null;
    }
    if (init?.signal) {
      init.signal.removeEventListener('abort', onAbort);
    }
  };

  const closeStream = () => {
    if (closed) return;
    closed = true;
    cleanup();
    try {
      streamController?.close();
    } catch {}
  };

  const failStream = (err: Error) => {
    if (closed) return;
    closed = true;
    cleanup();
    try {
      streamController?.error(err);
    } catch {}
  };

  const onAbort = () => {
    void invokeCommand('cancel_operator_http_stream', { requestId }).catch(() => {});
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    failStream(abortErr);
  };

  if (init?.signal) {
    init.signal.addEventListener('abort', onAbort, { once: true });
  }

  let resolveMeta!: (meta: { status: number; ok: boolean }) => void;
  let rejectMeta!: (err: Error) => void;
  const metaPromise = new Promise<{ status: number; ok: boolean }>((res, rej) => {
    resolveMeta = res;
    rejectMeta = rej;
  });

  const bodyStream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel() {
      void invokeCommand('cancel_operator_http_stream', { requestId }).catch(() => {});
      closed = true;
      cleanup();
    },
  });

  try {
    unlisten = await listenFn(eventName, (ev) => {
      const payload = ev?.payload;
      if (!payload || closed) return;

      if (payload.kind === 'meta') {
        if (!metaResolved) {
          metaResolved = true;
          resolveMeta({
            status: payload.status ?? 200,
            ok: payload.ok ?? true,
          });
        }
        return;
      }

      if (payload.kind === 'chunk' && typeof payload.text === 'string' && payload.text.length > 0) {
        if (!metaResolved) {
          metaResolved = true;
          resolveMeta({ status: 200, ok: true });
        }
        try {
          streamController?.enqueue(encoder.encode(payload.text));
        } catch {}
        return;
      }

      if (payload.kind === 'done') {
        if (!metaResolved) {
          metaResolved = true;
          resolveMeta({ status: payload.status ?? 200, ok: (payload.status ?? 200) < 300 });
        }
        closeStream();
        return;
      }

      if (payload.kind === 'aborted') {
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        if (!metaResolved) {
          metaResolved = true;
          rejectMeta(abortErr);
        }
        failStream(abortErr);
        return;
      }

      if (payload.kind === 'error') {
        const err = new Error(payload.error || 'Native HTTP stream error');
        if (!metaResolved) {
          metaResolved = true;
          rejectMeta(err);
        }
        failStream(err);
      }
    });
  } catch {
    cleanup();
    return operatorHttpFetch(url, init, options);
  }

  // Launch Rust stream command asynchronously; it emits chunks on `eventName` as they arrive.
  void invokeCommand<ProxyHttpResponse>('proxy_operator_http_stream', {
    requestId,
    url,
    method,
    headers: headersRecord,
    body: bodyStr,
    timeoutSecs: 60,
    ...(options?.credentialProvider
      ? { credentialProvider: options.credentialProvider }
      : {}),
  })
    .then((res) => {
      if (!metaResolved) {
        metaResolved = true;
        if (res && typeof res.status === 'number') {
          resolveMeta({ status: res.status, ok: Boolean(res.success) });
          if (res.body) {
            try {
              streamController?.enqueue(encoder.encode(res.body));
            } catch {}
          }
          closeStream();
        } else if (res && res.error) {
          const err = new Error(res.error);
          rejectMeta(err);
          failStream(err);
        } else {
          resolveMeta({ status: 200, ok: true });
          closeStream();
        }
      } else if (!closed) {
        closeStream();
      }
    })
    .catch((err) => {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      if (!metaResolved) {
        metaResolved = true;
        rejectMeta(errorObj);
      }
      failStream(errorObj);
    });

  try {
    const meta = await metaPromise;
    return new Response(bodyStream, {
      status: meta.status,
      statusText: meta.ok ? 'OK' : 'Stream Proxy Error',
      headers: new Headers({
        'Content-Type': 'text/event-stream',
        'X-Kite-Native-Stream': '1',
      }),
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw err;
    }
    // If native streaming command wasn't available yet before first byte, fall back to unary proxy.
    cleanup();
    return operatorHttpFetch(url, init, options);
  }
}
