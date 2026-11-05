import { invokeCommand } from '../lib/ipc';
import { getActiveAgentTerminals, waitForTerminalReady } from '../lib/terminalRegistry';

/** Motion contract: transform and opacity only. No animation library. */

export const MOTION_ENTER_MS = 180;
export const MOTION_EXIT_MS = 140;
/** Minimum splash time on cold start (bootstrap may finish underneath). */
export const APP_INTRO_MIN_MS = 3000;
export const LIVE_EDGE_THRESHOLD_PX = 48;

export const MOTION_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';

export function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined') {
    const mode = document.documentElement?.dataset?.motion;
    if (mode === 'reduce') return true;
    if (mode === 'full') return false;
  }
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function distanceFromLiveEdge(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number
): number {
  return scrollHeight - scrollTop - clientHeight;
}

export function isAtLiveEdge(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = LIVE_EDGE_THRESHOLD_PX
): boolean {
  return distanceFromLiveEdge(scrollHeight, scrollTop, clientHeight) <= threshold;
}

/** Move with the new pixels only. A reader who left the edge stays where they are. */
export function followLiveEdge(scrollTop: number, heightDelta: number, atEdge: boolean): number {
  if (!atEdge || heightDelta <= 0) return scrollTop;
  return scrollTop + heightDelta;
}

export function pulseZedOrb(): void {
  if (typeof window === 'undefined') return;
  if (prefersReducedMotion()) return;
  window.dispatchEvent(new CustomEvent('kite:zed-orb-ack'));
}

export interface PromptProjectileDispatchDetail {
  targetPaneId?: string;
  targetSessionId?: string;
  /** Legacy alias for `targetSessionId`; kept for dispatchers that name the session directly. */
  sessionId?: string;
  sourcePaneId?: string;
  sourceSessionId?: string;
  agentName?: string;
  engine?: string;
  prompt: string;
  /** Short badge shown on the in-flight capsule. Falls back to a prompt snippet. */
  label?: string;
  /** Per-shot spacing for broadcast volleys. */
  staggerMs?: number;
  /** Stable id so a repeated pickup does not submit twice. */
  requestId?: string;
  caller?: 'human' | 'agent' | 'script';
}

export type PromptFlightDetail = PromptProjectileDispatchDetail;

const PANE_READY_TIMEOUT_MS = 800;

function inNativeApp(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return Boolean(host.__TAURI_INTERNALS__ || host.__TAURI__);
}

function panePresence(state: string | undefined): string | undefined {
  switch (state) {
    case 'idle':
    case 'working':
    case 'done':
    case 'error':
      return state;
    case 'waitingForYou':
      return 'blocked';
    case 'exited':
      return 'gone';
    default:
      return undefined;
  }
}

async function deliverAcceptedPrompt(detail: PromptFlightDetail, sessionId: string): Promise<void> {
  const mounted =
    typeof document !== 'undefined' &&
    document.querySelector(`[data-session-id="${sessionId}"], .terminal-view-container[data-session-id="${sessionId}"]`) !== null;
  const observed = panePresence(getActiveAgentTerminals().find((t) => t.sessionId === sessionId)?.state);
  const receipt = await invokeCommand<{ status?: string; replayed?: boolean }>('dispatch_send', {
    id: detail.requestId,
    address: `session:${sessionId}`,
    body: detail.prompt,
    caller: detail.caller ?? (detail.sourceSessionId ? 'agent' : 'human'),
    from: detail.sourceSessionId ? `session:${detail.sourceSessionId}` : undefined,
    mounted,
    observed,
    presentationEmitted: false,
    source: detail.sourceSessionId,
    label: detail.label,
  });
  if (receipt?.replayed) return;
  if (receipt?.status && receipt.status !== 'submitted' && receipt.status !== 'settled') return;
}

/** Fire the slip after the destination pane is in the document, not on a fixed timer. */
export function dispatchPromptWhenPaneReady(detail: PromptFlightDetail): void {
  if (typeof window === 'undefined') return;

  const fire = () => {
    const sessionId = detail.targetSessionId ?? detail.sessionId;
    const inApp = inNativeApp();
    if (inApp && sessionId) {
      void deliverAcceptedPrompt(detail, sessionId).catch(() => {
        window.dispatchEvent(new CustomEvent('kite:dispatch-prompt-projectile', { detail }));
      });
      return;
    }
    window.dispatchEvent(new CustomEvent('kite:dispatch-prompt-projectile', { detail }));
  };

  const paneId = detail.targetPaneId;
  const sessionId = detail.targetSessionId ?? detail.sessionId;
  if (!paneId && !sessionId) {
    fire();
    return;
  }

  const readySelectors = [
    paneId ? `[data-leaf-id="${paneId}"]` : null,
    paneId ? `[data-pane-id="${paneId}"]` : null,
    sessionId ? `[data-session-id="${sessionId}"]` : null,
    sessionId ? `[data-leaf-session="${sessionId}"]` : null,
  ].filter((selector): selector is string => selector !== null);

  const isReady = () => readySelectors.some((selector) => document.querySelector(selector) !== null);

  const started = performance.now();
  const tick = () => {
    if (isReady() || performance.now() - started >= PANE_READY_TIMEOUT_MS) {
      if (sessionId) {
        // Pane is ready in DOM; now await terminal readiness reactively before launching projectile
        void waitForTerminalReady(sessionId).then(() => {
          fire();
        });
      } else {
        fire();
      }
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
