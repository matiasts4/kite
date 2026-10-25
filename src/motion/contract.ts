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

export interface PromptFlightDetail {
  targetPaneId?: string;
  targetSessionId: string;
  sourcePaneId?: string;
  sourceSessionId?: string;
  agentName?: string;
  engine?: string;
  prompt: string;
}

const PANE_READY_TIMEOUT_MS = 800;

/** Fire the slip after the destination pane is in the document, not on a fixed timer. */
export function dispatchPromptWhenPaneReady(detail: PromptFlightDetail): void {
  if (typeof window === 'undefined') return;

  const fire = () => {
    window.dispatchEvent(new CustomEvent('kite:dispatch-prompt-projectile', { detail }));
  };

  const paneId = detail.targetPaneId;
  if (!paneId) {
    fire();
    return;
  }

  const started = performance.now();
  const tick = () => {
    const ready = document.querySelector(`[data-leaf-id="${paneId}"]`);
    if (ready || performance.now() - started >= PANE_READY_TIMEOUT_MS) {
      fire();
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
