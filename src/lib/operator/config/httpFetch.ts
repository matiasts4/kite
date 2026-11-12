import { isTauriEnvironment, invokeCommand } from '../../ipc';

export interface ProxyHttpResponse {
  success: boolean;
  status: number;
  body: string;
  latency_ms: number;
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

export async function operatorHttpFetch(
  url: string,
  init?: RequestInit,
  options?: OperatorHttpFetchOptions
): Promise<Response> {
  if (isTauriEnvironment()) {
    try {
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
            'X-Proxy-Latency-Ms': String(proxyRes.latency_ms || 0),
          }),
        });
      }
    } catch {
      // Fallback to standard fetch if proxy command encounters an issue
    }
  }

  return fetch(url, init);
}
