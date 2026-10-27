import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  prefersReducedMotion,
  pulseZedOrb,
  type PromptProjectileDispatchDetail,
} from '../../motion/contract';
import './promptProjectile.css';

export type PromptProjectileDetail = PromptProjectileDispatchDetail;

export const PROMPT_INJECTION_DURATION_MS = 560;
/** Compact capsule copy: labels stay verbatim, raw prompts are cut to this width. */
export const PROMPT_CAPSULE_MAX_CHARS = 24;
/** Breath between shots when a volley lands in the same burst. */
export const PROMPT_STAGGER_STEP_MS = 85;
/** A gap wider than this opens a new volley instead of extending the current one. */
export const PROMPT_STAGGER_WINDOW_MS = 120;

const ARC_LIFT_PX = 28;
const SPAWN_DELAY_MS = 50;
const RING_DURATION_MS = 480;
const MAX_STAGGER_STEP_MS = 400;

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export function computeInjectionPoint(
  startX: number,
  startY: number,
  targetX: number,
  targetY: number,
  rawT: number
): { x: number; y: number; done: boolean } {
  const clamped = Math.min(1, Math.max(0, rawT));
  const t = easeOutCubic(clamped);
  const arc = -ARC_LIFT_PX * Math.sin(clamped * Math.PI);
  return {
    x: startX + (targetX - startX) * t,
    y: startY + (targetY - startY) * t + arc,
    done: clamped >= 1,
  };
}

/** Capsule copy: an explicit label wins; otherwise the prompt is cut to a readable snippet. */
export function promptCapsuleLabel(detail: PromptProjectileDetail): string {
  const explicit = detail.label?.trim();
  if (explicit) return explicit;
  const compact = detail.prompt.replace(/\s+/g, ' ').trim();
  if (compact.length <= PROMPT_CAPSULE_MAX_CHARS) return compact;
  return `${compact.slice(0, PROMPT_CAPSULE_MAX_CHARS).trimEnd()}…`;
}

export function dispatchTerminalStagedPrompt(detail: PromptProjectileDetail): void {
  window.dispatchEvent(
    new CustomEvent('kite:terminal-staged-prompt', {
      detail: {
        sessionId: detail.targetSessionId ?? detail.sessionId,
        paneId: detail.targetPaneId,
        prompt: detail.prompt,
        agentName: detail.agentName,
        engine: detail.engine,
      },
    })
  );
}

/** Impact notice: the target terminal plays its arrival wave from this event. */
export function dispatchPromptLanded(detail: PromptProjectileDetail): void {
  window.dispatchEvent(
    new CustomEvent('kite:prompt-landed', {
      detail: {
        sessionId: detail.targetSessionId ?? detail.sessionId,
        targetPaneId: detail.targetPaneId,
        sourceSessionId: detail.sourceSessionId,
        prompt: detail.prompt,
      },
    })
  );
}

function firstMatch(selectors: string[]): Element | null {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

function centerOf(el: Element): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

export function resolveSourcePosition(detail: PromptProjectileDetail): { startX: number; startY: number } {
  if (detail.sourcePaneId) {
    const paneEl = firstMatch([
      `[data-leaf-id="${detail.sourcePaneId}"]`,
      `[data-pane-id="${detail.sourcePaneId}"]`,
    ]);
    if (paneEl) {
      const c = centerOf(paneEl);
      return { startX: c.x, startY: c.y };
    }
  }

  if (detail.sourceSessionId) {
    const sessionEl = firstMatch([
      `.terminal-view-container[data-session-id="${detail.sourceSessionId}"]`,
      `[data-session-id="${detail.sourceSessionId}"]`,
      `[data-leaf-session="${detail.sourceSessionId}"]`,
    ]);
    if (sessionEl) {
      const c = centerOf(sessionEl);
      return { startX: c.x, startY: c.y };
    }
  }

  const orbEl =
    document.querySelector('.zed-float__orb') ||
    document.querySelector('.zed-float') ||
    document.querySelector('.zed-orb');

  if (orbEl) {
    const c = centerOf(orbEl);
    return { startX: c.x, startY: c.y };
  }

  return { startX: window.innerWidth - 70, startY: 120 };
}

export function resolveTargetPosition(detail: PromptProjectileDetail): {
  targetX: number;
  targetY: number;
} {
  let targetEl: Element | null = null;

  if (detail.targetPaneId) {
    targetEl = firstMatch([
      `.terminal-view-container[data-pane-id="${detail.targetPaneId}"]`,
      `[data-leaf-id="${detail.targetPaneId}"]`,
      `[data-pane-id="${detail.targetPaneId}"]`,
    ]);
  }

  if (!targetEl) {
    const sessionId = detail.targetSessionId ?? detail.sessionId;
    if (sessionId) {
      targetEl = firstMatch([
        `.terminal-view-container[data-session-id="${sessionId}"]`,
        `[data-session-id="${sessionId}"]`,
        `[data-leaf-session="${sessionId}"]`,
      ]);
    }
  }

  if (!targetEl) {
    const terminalPanes = document.querySelectorAll(
      '[data-testid="terminal-pane"], .pane-leaf--terminal, .terminal-view-container'
    );
    if (terminalPanes.length > 0) {
      targetEl = terminalPanes[terminalPanes.length - 1];
    }
  }

  if (!targetEl) {
    return { targetX: window.innerWidth * 0.6, targetY: window.innerHeight * 0.45 };
  }

  const rect = targetEl.getBoundingClientRect();
  return {
    targetX: rect.left + Math.max(50, Math.min(rect.width * 0.25, 140)),
    targetY: rect.top + Math.min(100, Math.max(60, rect.height * 0.4)),
  };
}

const TRAIL_LENGTH = 18;
const TRAIL_TAIL_COLOR = 'rgba(139, 92, 246, 0)';
const TRAIL_MID_COLOR = 'rgba(167, 139, 250, 0.65)';

interface FlightUi {
  id: string;
  label: string;
}

interface TrailPoint {
  x: number;
  y: number;
}

interface ActiveFlight {
  id: string;
  detail: PromptProjectileDetail;
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  startTime: number;
  el: HTMLElement | null;
  samples: TrailPoint[];
}

function trailColor(): string {
  if (typeof document === 'undefined') return '#8eb6ff';
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return raw || '#8eb6ff';
}

/** Tapered cyan-to-violet energy trail: thin and transparent at the tail, bright at the head. */
function paintTrail(canvas: HTMLCanvasElement | null, flights: Iterable<ActiveFlight>): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.lineCap = 'round';

  const accent = trailColor();
  for (const flight of flights) {
    const points = flight.samples;
    if (points.length < 2) continue;

    const tail = points[0];
    const head = points[points.length - 1];
    let stroke: string | CanvasGradient = accent;
    if (typeof ctx.createLinearGradient === 'function') {
      const gradient = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
      gradient.addColorStop(0, TRAIL_TAIL_COLOR);
      gradient.addColorStop(0.55, TRAIL_MID_COLOR);
      gradient.addColorStop(1, accent);
      stroke = gradient;
    }
    ctx.strokeStyle = stroke;

    for (let i = 1; i < points.length; i += 1) {
      const fade = i / (points.length - 1);
      ctx.globalAlpha = 0.2 + fade * 0.8;
      ctx.lineWidth = 0.6 + fade * fade * 2.8;
      ctx.beginPath();
      ctx.moveTo(points[i - 1].x, points[i - 1].y);
      ctx.lineTo(points[i].x, points[i].y);
      ctx.stroke();
    }

    ctx.globalAlpha = 0.9;
    ctx.fillStyle = accent;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(head.x, head.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;
}

interface PulseRing {
  id: string;
  x: number;
  y: number;
  kind: 'arrival' | 'launch';
}

export const PromptProjectileOverlay: React.FC = () => {
  const [flights, setFlights] = useState<FlightUi[]>([]);
  const [rings, setRings] = useState<PulseRing[]>([]);

  const flightsRef = useRef<Map<string, ActiveFlight>>(new Map());
  const trailRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const loopActiveRef = useRef(false);
  const launchTimersRef = useRef<number[]>([]);
  const ringTimersRef = useRef<number[]>([]);
  const burstRef = useRef<{ startedAt: number; count: number }>({ startedAt: 0, count: 0 });

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    loopActiveRef.current = false;
  }, []);

  const spawnRing = useCallback((ring: PulseRing, lifetimeMs: number) => {
    setRings((prev) => [...prev, ring]);
    const timer = window.setTimeout(() => {
      setRings((prev) => prev.filter((r) => r.id !== ring.id));
      ringTimersRef.current = ringTimersRef.current.filter((t) => t !== timer);
    }, lifetimeMs);
    ringTimersRef.current.push(timer);
  }, []);

  const completeFlight = useCallback(
    (flight: ActiveFlight) => {
      dispatchTerminalStagedPrompt(flight.detail);
      dispatchPromptLanded(flight.detail);
      spawnRing(
        { id: `ring-${flight.id}`, x: flight.targetX, y: flight.targetY, kind: 'arrival' },
        RING_DURATION_MS
      );
      flightsRef.current.delete(flight.id);
      setFlights((prev) => prev.filter((f) => f.id !== flight.id));
    },
    [spawnRing]
  );

  const runLoop = useCallback(() => {
    if (loopActiveRef.current) return;
    loopActiveRef.current = true;

    const tick = () => {
      const now = Date.now();
      let hasActive = false;
      const finished: ActiveFlight[] = [];

      for (const flight of flightsRef.current.values()) {
        if (!flight.el) {
          hasActive = true;
          continue;
        }

        const elapsed = now - flight.startTime;
        const rawT = elapsed / PROMPT_INJECTION_DURATION_MS;
        const { x, y, done } = computeInjectionPoint(
          flight.startX,
          flight.startY,
          flight.targetX,
          flight.targetY,
          rawT
        );

        flight.samples.push({ x: done ? flight.targetX : x, y: done ? flight.targetY : y });
        if (flight.samples.length > TRAIL_LENGTH) flight.samples.shift();
        flight.el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;

        if (done) finished.push(flight);
        else hasActive = true;
      }

      paintTrail(trailRef.current, flightsRef.current.values());
      for (const flight of finished) completeFlight(flight);

      if (hasActive && flightsRef.current.size > 0) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
        loopActiveRef.current = false;
      }
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [completeFlight]);

  const beginFlight = useCallback(
    (detail: PromptProjectileDetail) => {
      if (prefersReducedMotion()) {
        dispatchTerminalStagedPrompt(detail);
        return;
      }

      const { startX, startY } = resolveSourcePosition(detail);
      const { targetX, targetY } = resolveTargetPosition(detail);
      const id = `inj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const launchedFromZed = !detail.sourcePaneId && !detail.sourceSessionId;

      if (launchedFromZed) {
        pulseZedOrb();
      } else {
        spawnRing({ id: `launch-${id}`, x: startX, y: startY, kind: 'launch' }, RING_DURATION_MS);
      }

      flightsRef.current.set(id, {
        id,
        detail,
        startX,
        startY,
        targetX,
        targetY,
        startTime: Date.now(),
        el: null,
        samples: [],
      });

      setFlights((prev) => [...prev, { id, label: promptCapsuleLabel(detail) }]);
      runLoop();
    },
    [runLoop, spawnRing]
  );

  /** Volleys fan out: shots arriving inside the same burst wait one step each. */
  const scheduleFlight = useCallback(
    (detail: PromptProjectileDetail) => {
      if (prefersReducedMotion()) {
        dispatchTerminalStagedPrompt(detail);
        return;
      }

      const now = Date.now();
      const burst = burstRef.current;
      const continuing = burst.count > 0 && now - burst.startedAt < PROMPT_STAGGER_WINDOW_MS;
      const queueIndex = continuing ? burst.count : 0;
      const step = Math.min(MAX_STAGGER_STEP_MS, Math.max(0, detail.staggerMs ?? PROMPT_STAGGER_STEP_MS));

      burstRef.current = {
        startedAt: continuing ? burst.startedAt : now,
        count: queueIndex + 1,
      };

      const timer = window.setTimeout(() => {
        launchTimersRef.current = launchTimersRef.current.filter((t) => t !== timer);
        beginFlight(detail);
      }, SPAWN_DELAY_MS + queueIndex * step);
      launchTimersRef.current.push(timer);
    },
    [beginFlight]
  );

  const attachSlipRef = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      const flight = flightsRef.current.get(id);
      if (!flight) return;
      flight.el = el;
      if (el) {
        el.style.transform = `translate3d(${flight.startX}px, ${flight.startY}px, 0) translate(-50%, -50%)`;
        runLoop();
      }
    },
    [runLoop]
  );

  useEffect(() => {
    const handleDispatch = (e: Event) => {
      const customEvent = e as CustomEvent<PromptProjectileDetail>;
      if (!customEvent.detail?.prompt) return;
      scheduleFlight(customEvent.detail);
    };

    window.addEventListener('kite:dispatch-prompt-projectile', handleDispatch);
    return () => {
      window.removeEventListener('kite:dispatch-prompt-projectile', handleDispatch);
      launchTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      launchTimersRef.current = [];
      ringTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      ringTimersRef.current = [];
      stopLoop();
      flightsRef.current.clear();
    };
  }, [scheduleFlight, stopLoop]);

  if (flights.length === 0 && rings.length === 0) {
    return null;
  }

  return (
    <div className="prompt-projectile-overlay" aria-hidden="true">
      <canvas ref={trailRef} className="prompt-injection-trail" />
      {flights.map((flight) => (
        <div key={flight.id} ref={attachSlipRef(flight.id)} className="prompt-injection-dot">
          {flight.label ? <span className="prompt-injection-capsule">{flight.label}</span> : null}
        </div>
      ))}

      {rings.map((ring) => (
        <div
          key={ring.id}
          className={`prompt-injection-ring-host${
            ring.kind === 'launch' ? ' prompt-injection-ring-host--launch' : ''
          }`}
          style={{
            transform: `translate3d(${ring.x}px, ${ring.y}px, 0) translate(-50%, -50%)`,
          }}
        >
          <div
            className={`prompt-injection-ring${
              ring.kind === 'launch' ? ' prompt-injection-ring--launch' : ''
            }`}
          />
        </div>
      ))}
    </div>
  );
};

export default PromptProjectileOverlay;
