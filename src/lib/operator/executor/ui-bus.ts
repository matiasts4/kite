// Kite Code — Operator UI Bus (Typed Request/Ack)
// Replaces loose DOM events with guaranteed acknowledgements between Operator executor and React views.

import { emitTrace } from '../trace/trace';

export type UiRequestKind =
  | 'navigate'
  | 'spawn-terminal'
  | 'close-terminal'
  | 'inject-prompt'
  | 'query-status';

export interface UiBusRequestPayload {
  reqId: string;
  kind: UiRequestKind;
  turnId?: string;
  payload: Record<string, unknown>;
}

export interface UiBusAckPayload {
  reqId: string;
  ok: boolean;
  sessionId?: string;
  reason?: string;
  data?: unknown;
}

export interface UiRequestOptions {
  timeoutMs?: number;
  turnId?: string;
}

const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Sends a typed request to the UI components (App or CodeWorkspace) and awaits a guaranteed ACK.
 */
export function sendUiRequest<T = unknown>(
  kind: UiRequestKind,
  payload: Record<string, unknown> = {},
  options: UiRequestOptions = {}
): Promise<UiBusAckPayload & { data?: T }> {
  if (typeof window === 'undefined') {
    return Promise.resolve({
      reqId: 'ssr',
      ok: false,
      reason: 'sin-entorno-dom',
    });
  }

  const reqId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const turnId = options.turnId || `turn-${Date.now()}`;
  const startMs = Date.now();

  emitTrace({
    turnId,
    ev: 'ui.request',
    reqId,
    kind,
    payload,
  });

  return new Promise((resolve) => {
    let timer: number | null = null;

    const onAck = (event: Event) => {
      const custom = event as CustomEvent<UiBusAckPayload>;
      if (!custom.detail || custom.detail.reqId !== reqId) return;

      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      window.removeEventListener('kite:op-ack', onAck);

      const elapsedMs = Date.now() - startMs;
      emitTrace({
        turnId,
        ev: 'ui.ack',
        reqId,
        ok: custom.detail.ok,
        sessionId: custom.detail.sessionId,
        reason: custom.detail.reason,
        ms: elapsedMs,
      });

      resolve(custom.detail as UiBusAckPayload & { data?: T });
    };

    window.addEventListener('kite:op-ack', onAck);

    timer = window.setTimeout(() => {
      window.removeEventListener('kite:op-ack', onAck);
      const elapsedMs = Date.now() - startMs;
      const failAck: UiBusAckPayload = {
        reqId,
        ok: false,
        reason: 'sin-receptor (timeout agotado)',
      };

      emitTrace({
        turnId,
        ev: 'ui.ack',
        reqId,
        ok: false,
        reason: failAck.reason,
        ms: elapsedMs,
      });

      resolve(failAck as any);
    }, timeoutMs);

    window.dispatchEvent(
      new CustomEvent<UiBusRequestPayload>('kite:op-request', {
        detail: {
          reqId,
          kind,
          turnId,
          payload,
        },
      })
    );
  });
}

/**
 * Responds to a received UI request with an ACK.
 */
export function sendUiAck(ack: UiBusAckPayload): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<UiBusAckPayload>('kite:op-ack', {
      detail: ack,
    })
  );
}

/**
 * Waits until CodeWorkspace broadcasts that it is mounted and ready to receive spawn requests.
 */
export function waitForCodeWorkspaceReady(timeoutMs: number = 3000): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);

  // If already signaled ready on window global
  if ((window as unknown as { __kiteCodeWorkspaceMounted?: boolean }).__kiteCodeWorkspaceMounted) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let timer: number | null = null;

    const onReady = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      window.removeEventListener('kite:code-workspace-ready', onReady);
      resolve(true);
    };

    window.addEventListener('kite:code-workspace-ready', onReady);

    timer = window.setTimeout(() => {
      window.removeEventListener('kite:code-workspace-ready', onReady);
      resolve(false);
    }, timeoutMs);
  });
}
