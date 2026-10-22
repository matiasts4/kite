import React, { useCallback, useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../../motion/contract';
import './promptProjectile.css';

export interface PromptProjectileDetail {
  targetPaneId?: string;
  targetSessionId: string;
  sourcePaneId?: string;
  sourceSessionId?: string;
  agentName?: string;
  engine?: string;
  prompt: string;
}

export const PROMPT_INJECTION_DURATION_MS = 560;
const ARC_LIFT_PX = 28;
const SPAWN_DELAY_MS = 50;
const RING_DURATION_MS = 480;

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

export function dispatchTerminalStagedPrompt(detail: PromptProjectileDetail): void {
  window.dispatchEvent(
    new CustomEvent('kite:terminal-staged-prompt', {
      detail: {
        sessionId: detail.targetSessionId,
        paneId: detail.targetPaneId,
        prompt: detail.prompt,
        agentName: detail.agentName,
        engine: detail.engine,
      },
    })
  );
}

function centerOf(el: Element): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

export function resolveSourcePosition(detail: PromptProjectileDetail): { startX: number; startY: number } {
  let startX = window.innerWidth - 70;
  let startY = 120;

  if (detail.sourcePaneId) {
    const paneEl = document.querySelector(`[data-leaf-id="${detail.sourcePaneId}"]`);
    if (paneEl) {
      const c = centerOf(paneEl);
      return { startX: c.x, startY: c.y };
    }
  }

  if (detail.sourceSessionId) {
    const sessionEl =
      document.querySelector(`[data-session-id="${detail.sourceSessionId}"]`) ||
      document.querySelector(`[data-leaf-session="${detail.sourceSessionId}"]`);
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

  return { startX, startY };
}

export function resolveTargetPosition(detail: PromptProjectileDetail): { targetX: number; targetY: number } {
  let targetX = window.innerWidth * 0.6;
  let targetY = window.innerHeight * 0.45;

  let targetEl: Element | null = null;
  if (detail.targetPaneId) {
    targetEl = document.querySelector(`[data-leaf-id="${detail.targetPaneId}"]`);
  }
  if (!targetEl && detail.targetSessionId) {
    targetEl =
      document.querySelector(`[data-session-id="${detail.targetSessionId}"]`) ||
      document.querySelector(`[data-leaf-session="${detail.targetSessionId}"]`);
  }
  if (!targetEl) {
    const terminalPanes = document.querySelectorAll(
      '[data-testid="terminal-pane"], .pane-leaf--terminal, .terminal-view-container'
    );
    if (terminalPanes.length > 0) {
      targetEl = terminalPanes[terminalPanes.length - 1];
    }
  }

  if (targetEl) {
    const rect = targetEl.getBoundingClientRect();
    targetX = rect.left + Math.max(50, Math.min(rect.width * 0.25, 140));
    targetY = rect.top + Math.min(100, Math.max(60, rect.height * 0.4));
  }

  return { targetX, targetY };
}

const TRAIL_LENGTH = 18;

interface FlightUi {
  id: string;
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
  ctx.strokeStyle = trailColor();
  for (const flight of flights) {
    const points = flight.samples;
    for (let i = 1; i < points.length; i += 1) {
      const fade = i / (points.length - 1);
      ctx.globalAlpha = fade * 0.85;
      ctx.lineWidth = 1 + fade * 1.6;
      ctx.beginPath();
      ctx.moveTo(points[i - 1].x, points[i - 1].y);
      ctx.lineTo(points[i].x, points[i].y);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

interface ArrivalRing {
  id: string;
  x: number;
  y: number;
}

export const PromptProjectileOverlay: React.FC = () => {
  const [flights, setFlights] = useState<FlightUi[]>([]);
  const [rings, setRings] = useState<ArrivalRing[]>([]);

  const flightsRef = useRef<Map<string, ActiveFlight>>(new Map());
  const trailRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const loopActiveRef = useRef(false);

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    loopActiveRef.current = false;
  }, []);

  const completeFlight = useCallback((flight: ActiveFlight) => {
    dispatchTerminalStagedPrompt(flight.detail);
    const ringId = `ring-${flight.id}`;
    setRings((prev) => [...prev, { id: ringId, x: flight.targetX, y: flight.targetY }]);
    window.setTimeout(() => {
      setRings((prev) => prev.filter((r) => r.id !== ringId));
    }, RING_DURATION_MS);
    flightsRef.current.delete(flight.id);
    setFlights((prev) => prev.filter((f) => f.id !== flight.id));
  }, []);

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

      setFlights((prev) => [...prev, { id }]);

      runLoop();
    },
    [runLoop]
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

      window.setTimeout(() => {
        beginFlight(customEvent.detail);
      }, SPAWN_DELAY_MS);
    };

    window.addEventListener('kite:dispatch-prompt-projectile', handleDispatch);
    return () => {
      window.removeEventListener('kite:dispatch-prompt-projectile', handleDispatch);
      stopLoop();
      flightsRef.current.clear();
    };
  }, [beginFlight, stopLoop]);

  if (flights.length === 0 && rings.length === 0) {
    return null;
  }

  return (
    <div className="prompt-projectile-overlay" aria-hidden="true">
      <canvas ref={trailRef} className="prompt-injection-trail" />
      {flights.map((flight) => (
        <div
          key={flight.id}
          ref={attachSlipRef(flight.id)}
          className="prompt-injection-dot"
        />
      ))}

      {rings.map((ring) => (
        <div
          key={ring.id}
          className="prompt-injection-ring-host"
          style={{
            transform: `translate3d(${ring.x}px, ${ring.y}px, 0) translate(-50%, -50%)`,
          }}
        >
          <div className="prompt-injection-ring" />
        </div>
      ))}
    </div>
  );
};

export default PromptProjectileOverlay;
