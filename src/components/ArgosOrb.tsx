import React, { useEffect, useRef, useState } from 'react';
import { OrbRenderer } from './orbRenderer';
import {
  getArgosFigureShaderMode,
  sanitizeArgosFigure,
  type ArgosFigureId,
} from '../lib/operator/operatorConfig';
import './argosFloat.css';

export type ArgosOrbState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'thinking'
  | 'speaking'
  | 'listening'
  | 'error'
  | 'muted';

export type ZedOrbState = ArgosOrbState;

export interface ArgosOrbProps {
  state?: ArgosOrbState | string;
  figure?: ArgosFigureId;
  size?: number;
  level?: number;
  getLevel?: () => number;
  interactive?: boolean;
  /** Optional external host element (e.g. draggable handle wrapper) whose pointer events drive 3D tilt, hover, and tactile click ripples. */
  pointerTargetRef?: React.RefObject<HTMLElement | null>;
  /** Increment to trigger a radial shockwave ripple on the living figure. */
  pulseKey?: number;
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
  title?: string;
  ariaLabel?: string;
  badge?: React.ReactNode;
}

export type ZedOrbProps = ArgosOrbProps;

const RIPPLE_DURATION_MS = 680;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function isMotionReduced(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.getAttribute('data-motion') === 'reduce') {
    return true;
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  return false;
}

function resolvePaletteKey(state: string): string {
  switch (state) {
    case 'listening':
      return 'listening';
    case 'connecting':
      return 'connecting';
    case 'error':
      return 'error';
    case 'thinking':
      return 'thinking';
    case 'speaking':
      return 'speaking';
    case 'idle':
    case 'muted':
      return 'idle';
    default:
      return 'connected';
  }
}

export const ArgosOrb: React.FC<ArgosOrbProps> = ({
  state = 'connected',
  figure = 'plasma-orb',
  size = 132,
  level = 0,
  getLevel,
  interactive = false,
  pointerTargetRef,
  pulseKey = 0,
  onClick,
  title,
  ariaLabel,
  badge,
}) => {
  const rootRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<OrbRenderer | null>(null);
  const [hasWebGL, setHasWebGL] = useState(true);

  const safeFigure = sanitizeArgosFigure(figure);
  const shaderMode = getArgosFigureShaderMode(safeFigure);

  const targetTiltRef = useRef({ x: 0, y: 0 });
  const currentTiltRef = useRef({ x: 0, y: 0 });
  const targetHoverRef = useRef(0);
  const currentHoverRef = useRef(0);
  const rippleStartRef = useRef(0);
  const rippleOriginRef = useRef({ x: 0, y: 0 });
  const smoothedLevelRef = useRef(0);
  const peakLevelRef = useRef(0);
  const startTimeRef = useRef(performance.now());
  const stateRef = useRef(state);
  const levelPropRef = useRef(level);
  const getLevelRef = useRef(getLevel);
  const modeRef = useRef(shaderMode);
  const wakeLoopRef = useRef<(() => void) | null>(null);
  stateRef.current = state;
  levelPropRef.current = level;
  getLevelRef.current = getLevel;
  modeRef.current = shaderMode;

  const triggerRipple = (nx = 0, ny = 0) => {
    rippleStartRef.current = performance.now();
    rippleOriginRef.current = { x: clamp(nx, -1, 1), y: clamp(ny, -1, 1) };
    wakeLoopRef.current?.();
  };

  // Emit a tactile ripple on explicit pulseKey changes or global ack pulses
  useEffect(() => {
    if (pulseKey > 0) {
      triggerRipple(0, 0);
    }
  }, [pulseKey]);

  useEffect(() => {
    const onAck = () => triggerRipple(0, 0);
    window.addEventListener('kite:argos-orb-ack', onAck);
    window.addEventListener('kite:zed-orb-ack', onAck);
    return () => {
      window.removeEventListener('kite:argos-orb-ack', onAck);
      window.removeEventListener('kite:zed-orb-ack', onAck);
    };
  }, []);

  // Attach pointer interactivity to external host (e.g. ArgosStrip orb container over drag handle)
  useEffect(() => {
    const host = pointerTargetRef?.current;
    if (!host) return;

    const computeNormalized = (clientX: number, clientY: number) => {
      const rect = host.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
      const nx = ((clientX - rect.left) / rect.width - 0.5) * 2;
      const ny = ((clientY - rect.top) / rect.height - 0.5) * 2;
      return { x: clamp(nx, -1, 1), y: clamp(ny, -1, 1) };
    };

    const onMove = (e: PointerEvent) => {
      targetHoverRef.current = 1;
      targetTiltRef.current = computeNormalized(e.clientX, e.clientY);
      wakeLoopRef.current?.();
    };
    const onEnter = () => {
      targetHoverRef.current = 1;
      wakeLoopRef.current?.();
    };
    const onLeave = () => {
      targetHoverRef.current = 0;
      targetTiltRef.current = { x: 0, y: 0 };
      wakeLoopRef.current?.();
    };
    const onDown = (e: PointerEvent) => {
      const pt = computeNormalized(e.clientX, e.clientY);
      targetHoverRef.current = 1;
      targetTiltRef.current = pt;
      triggerRipple(pt.x, -pt.y);
    };

    host.addEventListener('pointermove', onMove, { passive: true });
    host.addEventListener('pointerenter', onEnter, { passive: true });
    host.addEventListener('pointerleave', onLeave, { passive: true });
    host.addEventListener('pointerdown', onDown, { passive: true });
    return () => {
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerenter', onEnter);
      host.removeEventListener('pointerleave', onLeave);
      host.removeEventListener('pointerdown', onDown);
    };
  }, [pointerTargetRef]);

  useEffect(() => {
    // Tiny indicators (<32px) stay pure CSS with zero WebGL contexts
    if (size < 32) {
      setHasWebGL(false);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new OrbRenderer(canvas);
    if (!renderer.isReady()) {
      setHasWebGL(false);
      renderer.dispose();
      return;
    }
    renderer.resize(size, size);
    rendererRef.current = renderer;
    setHasWebGL(true);
    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [size]);

  useEffect(() => {
    if (size < 32) return;

    let rafId = 0;
    let isDisposed = false;
    let isRunning = false;
    let lastRenderTime = 0;
    let lastCalmSignature = '';
    const startTime = startTimeRef.current;

    const lastWrittenStyles = {
      level: -1,
      peak: -1,
      hover: -1,
      ripple: -1,
      tiltX: -999,
      tiltY: -999,
    };

    const renderFrame = (now: number) => {
      const curState = stateRef.current;
      const elapsedSec = (now - startTime) * 0.001;
      const rawInputLevel = getLevelRef.current
        ? getLevelRef.current()
        : levelPropRef.current ?? 0;

      let ambientLevel = 0;
      if (curState === 'speaking') {
        ambientLevel =
          0.18 +
          0.07 * Math.sin(elapsedSec * 1.9) +
          0.03 * Math.sin(elapsedSec * 3.4 + 0.8);
      } else if (curState === 'thinking') {
        ambientLevel = 0.14 + 0.05 * Math.sin(elapsedSec * 1.7);
      } else if (curState === 'connecting') {
        ambientLevel = 0.11 + 0.04 * Math.sin(elapsedSec * 1.4);
      } else if (curState === 'connected') {
        ambientLevel = 0.05 + 0.02 * Math.sin(elapsedSec * 0.9);
      }

      const targetLevel = clamp(Math.max(rawInputLevel, ambientLevel), 0, 1);
      const prevLevel = smoothedLevelRef.current;
      const alpha = targetLevel > prevLevel ? 0.16 : 0.08;
      const nextLevel = prevLevel + (targetLevel - prevLevel) * alpha;
      smoothedLevelRef.current = nextLevel;

      const nextPeak = Math.max(nextLevel, peakLevelRef.current * 0.96);
      peakLevelRef.current = nextPeak;

      const curTilt = currentTiltRef.current;
      const tgtTilt = targetTiltRef.current;
      curTilt.x += (tgtTilt.x - curTilt.x) * 0.16;
      curTilt.y += (tgtTilt.y - curTilt.y) * 0.16;

      currentHoverRef.current += (targetHoverRef.current - currentHoverRef.current) * 0.16;
      const curHover = currentHoverRef.current;

      let ripplePhase = 0;
      if (rippleStartRef.current > 0) {
        const elapsedRipple = now - rippleStartRef.current;
        if (elapsedRipple < RIPPLE_DURATION_MS) {
          ripplePhase = clamp(elapsedRipple / RIPPLE_DURATION_MS, 0, 1);
        } else {
          rippleStartRef.current = 0;
        }
      }

      const el = rootRef.current;
      if (el) {
        const tiltXVal = curTilt.y * -10;
        const tiltYVal = curTilt.x * 10;
        const shiftXVal = curTilt.x * 5;
        const shiftYVal = curTilt.y * 5;

        if (
          Math.abs(nextLevel - lastWrittenStyles.level) > 0.015 ||
          Math.abs(nextPeak - lastWrittenStyles.peak) > 0.02 ||
          Math.abs(curHover - lastWrittenStyles.hover) > 0.02 ||
          Math.abs(ripplePhase - lastWrittenStyles.ripple) > 0.02 ||
          Math.abs(tiltXVal - lastWrittenStyles.tiltX) > 0.15 ||
          Math.abs(tiltYVal - lastWrittenStyles.tiltY) > 0.15
        ) {
          el.style.setProperty('--orb-level', nextLevel.toFixed(3));
          el.style.setProperty('--orb-peak', nextPeak.toFixed(3));
          el.style.setProperty('--orb-hover', curHover.toFixed(3));
          el.style.setProperty('--orb-ripple', ripplePhase.toFixed(3));
          el.style.setProperty('--orb-tilt-x', `${tiltXVal.toFixed(2)}deg`);
          el.style.setProperty('--orb-tilt-y', `${tiltYVal.toFixed(2)}deg`);
          el.style.setProperty('--orb-shift-x', `${shiftXVal.toFixed(2)}px`);
          el.style.setProperty('--orb-shift-y', `${shiftYVal.toFixed(2)}px`);

          lastWrittenStyles.level = nextLevel;
          lastWrittenStyles.peak = nextPeak;
          lastWrittenStyles.hover = curHover;
          lastWrittenStyles.ripple = ripplePhase;
          lastWrittenStyles.tiltX = tiltXVal;
          lastWrittenStyles.tiltY = tiltYVal;
        }
      }

      const renderer = rendererRef.current;
      if (renderer && renderer.isReady()) {
        const reactivity =
          curState === 'idle' || curState === 'muted'
            ? 0.3
            : curState === 'speaking'
            ? 1.0
            : 0.85;
        const thinkingVal =
          curState === 'thinking' || curState === 'connecting' ? 1.0 : 0.0;
        const idleVal = curState === 'idle' || curState === 'muted' ? 1.0 : 0.0;

        renderer.render({
          time: elapsedSec,
          level: nextLevel,
          reactivity,
          thinking: thinkingVal,
          idle: idleVal,
          hover: curHover,
          ripple: ripplePhase,
          rippleOriginX: rippleOriginRef.current.x,
          rippleOriginY: rippleOriginRef.current.y,
          mode: modeRef.current,
          tiltX: curTilt.x,
          tiltY: curTilt.y,
          paletteKey: resolvePaletteKey(curState),
        });
      }
    };

    // Reduced-motion mode renders one clean static frame with zero continuous RAF loop
    if (isMotionReduced()) {
      renderFrame(performance.now());
      return;
    }

    const isWindowMinimized = () =>
      typeof document !== 'undefined' &&
      (document.hidden || document.documentElement.getAttribute('data-window-state') === 'minimized');

    const isCalmWithoutActivity = () => {
      const curState = stateRef.current;
      const isCalmState = curState === 'idle' || curState === 'muted' || curState === 'connected';
      if (!isCalmState) return false;
      const rawInputLevel = getLevelRef.current
        ? getLevelRef.current()
        : levelPropRef.current ?? 0;
      const isInteracting =
        targetHoverRef.current > 0.02 ||
        currentHoverRef.current > 0.02 ||
        rippleStartRef.current > 0 ||
        Math.abs(targetTiltRef.current.x) > 0.02 ||
        Math.abs(targetTiltRef.current.y) > 0.02 ||
        Math.abs(currentTiltRef.current.x) > 0.02 ||
        Math.abs(currentTiltRef.current.y) > 0.02 ||
        rawInputLevel > 0.015;
      return !isInteracting;
    };

    const tick = (now: number) => {
      if (isDisposed) return;

      // When minimized or tab is hidden, stop RAF completely (0 CPU / 0 GPU)
      if (isWindowMinimized()) {
        isRunning = false;
        return;
      }

      if (now - lastRenderTime < 16) {
        rafId = window.requestAnimationFrame(tick);
        return;
      }
      lastRenderTime = now;

      renderFrame(now);
      if (isCalmWithoutActivity()) {
        isRunning = false;
        return;
      }
      rafId = window.requestAnimationFrame(tick);
    };

    const startLoop = () => {
      if (isRunning || isDisposed || isMotionReduced() || isWindowMinimized()) return;
      if (isCalmWithoutActivity()) {
        const sig = `${stateRef.current}|${modeRef.current}|${(levelPropRef.current ?? 0).toFixed(3)}`;
        if (sig !== lastCalmSignature) {
          lastCalmSignature = sig;
          renderFrame(performance.now());
        }
        return;
      }
      lastCalmSignature = '';
      isRunning = true;
      lastRenderTime = 0;
      rafId = window.requestAnimationFrame(tick);
    };

    wakeLoopRef.current = startLoop;

    const handleVisibilityChange = () => {
      if (!isWindowMinimized()) {
        startLoop();
      }
    };

    startLoop();

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      isDisposed = true;
      isRunning = false;
      wakeLoopRef.current = null;
      window.cancelAnimationFrame(rafId);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, [size]);

  // Wake or re-render one crisp static frame when state/figure/level changes
  useEffect(() => {
    if (size < 32) return;
    if (!isMotionReduced()) {
      wakeLoopRef.current?.();
      return;
    }
    const renderer = rendererRef.current;
    if (!renderer || !renderer.isReady()) return;
    const isIdle = state === 'idle' || state === 'muted';
    renderer.render({
      time: 1.2,
      level: clamp(level, 0, 1),
      reactivity: isIdle ? 0.3 : 0.85,
      thinking: state === 'thinking' || state === 'connecting' ? 1.0 : 0.0,
      idle: isIdle ? 1.0 : 0.0,
      hover: 0,
      ripple: 0,
      rippleOriginX: 0,
      rippleOriginY: 0,
      mode: shaderMode,
      tiltX: 0,
      tiltY: 0,
      paletteKey: resolvePaletteKey(state),
    });
  }, [size, state, shaderMode, level]);

  const computeLocalNormalized = (e: React.PointerEvent<HTMLElement>) => {
    const el = rootRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
    const nx = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
    const ny = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
    return { x: clamp(nx, -1, 1), y: clamp(ny, -1, 1) };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLElement>) => {
    targetHoverRef.current = 1;
    targetTiltRef.current = computeLocalNormalized(e);
    wakeLoopRef.current?.();
  };

  const handlePointerEnter = () => {
    targetHoverRef.current = 1;
    wakeLoopRef.current?.();
  };

  const handlePointerLeave = () => {
    targetHoverRef.current = 0;
    targetTiltRef.current = { x: 0, y: 0 };
    wakeLoopRef.current?.();
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    const pt = computeLocalNormalized(e);
    targetHoverRef.current = 1;
    targetTiltRef.current = pt;
    triggerRipple(pt.x, -pt.y);
  };

  const Tag: React.ElementType = interactive ? 'button' : 'div';
  const styleVars = {
    '--orb-size': `${size}px`,
  } as React.CSSProperties;

  return (
    <Tag
      ref={rootRef as React.Ref<never>}
      type={interactive ? 'button' : undefined}
      className={[
        'argos-orb',
        'zed-orb',
        `zed-orb--${state}`,
        `zed-orb--mode-${safeFigure}`,
        interactive ? 'argos-orb--interactive zed-orb--interactive' : '',
        hasWebGL ? 'zed-orb--webgl' : 'zed-orb--fallback',
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid="zed-orb"
      data-figure={safeFigure}
      data-shader-mode={shaderMode}
      data-state={state}
      style={styleVars}
      onClick={onClick}
      onPointerMove={handlePointerMove}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onPointerDown={handlePointerDown}
      title={title}
      aria-label={ariaLabel ?? title}
    >
      <span className="zed-orb__backdrop" aria-hidden="true" />
      <span className="zed-orb__aura" aria-hidden="true" />

      <canvas ref={canvasRef} className="zed-orb__canvas" aria-hidden="true" />

      {!hasWebGL && (
        <span className="zed-orb__sphere" aria-hidden="true">
          <span className="zed-orb__plasma zed-orb__plasma--a" />
          <span className="zed-orb__plasma zed-orb__plasma--b" />
          <span className="zed-orb__plasma zed-orb__plasma--c" />
          <span className="zed-orb__core" />
          <span className="zed-orb__caustics" />
          <span className="zed-orb__fresnel" />
          <span className="zed-orb__specular" />
          <span className="zed-orb__specular-secondary" />
          <span className="zed-orb__sheen" />
        </span>
      )}

      <svg
        className="zed-orb__sweep"
        viewBox="0 0 120 120"
        aria-hidden="true"
        focusable="false"
      >
        <circle
          cx="60"
          cy="60"
          r="54"
          fill="none"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeDasharray="68 280"
        />
      </svg>

      {badge && <span className="zed-orb__badge">{badge}</span>}
    </Tag>
  );
};

export const ZedOrb = ArgosOrb;

export default ArgosOrb;
