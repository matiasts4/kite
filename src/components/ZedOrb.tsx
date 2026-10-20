import React, { useEffect, useRef, useState } from 'react';
import { OrbRenderer } from './orbRenderer';

export type ZedOrbState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'thinking'
  | 'speaking'
  | 'listening'
  | 'error'
  | 'muted';



export interface ZedOrbProps {
  state?: ZedOrbState | string;
  size?: number;
  level?: number;
  getLevel?: () => number;
  interactive?: boolean;
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
  title?: string;
  ariaLabel?: string;
  badge?: React.ReactNode;
}



function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
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

export const ZedOrb: React.FC<ZedOrbProps> = ({
  state = 'connected',
  size = 132,
  level = 0,
  getLevel,
  interactive = false,
  onClick,
  title,
  ariaLabel,
  badge,
}) => {
  const rootRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<OrbRenderer | null>(null);
  const [hasWebGL, setHasWebGL] = useState(true);

  const targetTiltRef = useRef({ x: 0, y: 0 });
  const currentTiltRef = useRef({ x: 0, y: 0 });
  const smoothedLevelRef = useRef(0);
  const peakLevelRef = useRef(0);
  const stateRef = useRef(state);
  const levelPropRef = useRef(level);
  const getLevelRef = useRef(getLevel);
  stateRef.current = state;
  levelPropRef.current = level;
  getLevelRef.current = getLevel;

  useEffect(() => {
    // For small orbs (e.g. TitleBar 16px), bypass WebGL completely to save GPU and WebGL contexts
    if (size < 32) {
      setHasWebGL(false);
      if (rendererRef.current) {
        rendererRef.current.dispose();
        rendererRef.current = null;
      }
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
    if (size < 32) {
      return;
    }

    let rafId = 0;
    let isDisposed = false;
    let lastRenderTime = 0;
    const startTime = performance.now();

    const lastWrittenStyles = {
      level: -1,
      peak: -1,
      tiltX: -999,
      tiltY: -999,
      shiftX: -999,
      shiftY: -999,
    };

    const tick = (now: number) => {
      if (isDisposed) return;

      // Pause rendering loop if window or tab is hidden/minimized
      if (typeof document !== 'undefined' && document.hidden) {
        rafId = window.requestAnimationFrame(tick);
        return;
      }

      const curState = stateRef.current;
      const isIdle = curState === 'idle' || curState === 'muted' || curState === 'connected';

      // Throttle rendering when idle to save CPU/GPU cycles (target ~30fps when idle, 60fps when active)
      const minInterval = isIdle ? 33 : 16;
      if (now - lastRenderTime < minInterval) {
        rafId = window.requestAnimationFrame(tick);
        return;
      }
      lastRenderTime = now;

      const elapsedSec = (now - startTime) * 0.001;
      const rawInputLevel = getLevelRef.current
        ? getLevelRef.current()
        : levelPropRef.current ?? 0;

      let ambientLevel = 0;
      if (curState === 'speaking') {
        ambientLevel =
          0.16 +
          0.06 * Math.sin(elapsedSec * 1.8) +
          0.03 * Math.sin(elapsedSec * 3.2 + 0.8);
      } else if (curState === 'thinking') {
        ambientLevel = 0.12 + 0.05 * Math.sin(elapsedSec * 1.6);
      } else if (curState === 'connecting') {
        ambientLevel = 0.10 + 0.04 * Math.sin(elapsedSec * 1.4);
      } else if (curState === 'connected') {
        ambientLevel = 0.05 + 0.02 * Math.sin(elapsedSec * 1.0);
      }

      const targetLevel = clamp(Math.max(rawInputLevel, ambientLevel), 0, 1);
      const prevLevel = smoothedLevelRef.current;
      const alpha = targetLevel > prevLevel ? 0.12 : 0.06;
      const nextLevel = prevLevel + (targetLevel - prevLevel) * alpha;
      smoothedLevelRef.current = nextLevel;

      const nextPeak = Math.max(nextLevel, peakLevelRef.current * 0.965);
      peakLevelRef.current = nextPeak;

      const curTilt = currentTiltRef.current;
      const tgtTilt = targetTiltRef.current;
      curTilt.x += (tgtTilt.x - curTilt.x) * 0.12;
      curTilt.y += (tgtTilt.y - curTilt.y) * 0.12;

      // Smart DOM style throttling: only write to DOM when change is visually noticeable
      const el = rootRef.current;
      if (el) {
        const tiltXVal = curTilt.y * -9;
        const tiltYVal = curTilt.x * 9;
        const shiftXVal = curTilt.x * 5;
        const shiftYVal = curTilt.y * 5;

        if (
          Math.abs(nextLevel - lastWrittenStyles.level) > 0.008 ||
          Math.abs(nextPeak - lastWrittenStyles.peak) > 0.015 ||
          Math.abs(tiltXVal - lastWrittenStyles.tiltX) > 0.08 ||
          Math.abs(tiltYVal - lastWrittenStyles.tiltY) > 0.08
        ) {
          el.style.setProperty('--orb-level', nextLevel.toFixed(3));
          el.style.setProperty('--orb-peak', nextPeak.toFixed(3));
          el.style.setProperty('--orb-tilt-x', `${tiltXVal.toFixed(2)}deg`);
          el.style.setProperty('--orb-tilt-y', `${tiltYVal.toFixed(2)}deg`);
          el.style.setProperty('--orb-shift-x', `${shiftXVal.toFixed(2)}px`);
          el.style.setProperty('--orb-shift-y', `${shiftYVal.toFixed(2)}px`);

          lastWrittenStyles.level = nextLevel;
          lastWrittenStyles.peak = nextPeak;
          lastWrittenStyles.tiltX = tiltXVal;
          lastWrittenStyles.tiltY = tiltYVal;
          lastWrittenStyles.shiftX = shiftXVal;
          lastWrittenStyles.shiftY = shiftYVal;
        }
      }

      const renderer = rendererRef.current;
      if (renderer && renderer.isReady()) {
        const reactivity =
          curState === 'idle' || curState === 'muted'
            ? 0.25
            : curState === 'speaking'
            ? 1.0
            : 0.78;
        const thinkingVal =
          curState === 'thinking' || curState === 'connecting' ? 1.0 : 0.0;
        const idleVal = curState === 'idle' || curState === 'muted' ? 1.0 : 0.0;

        renderer.render({
          time: elapsedSec,
          level: nextLevel,
          reactivity,
          thinking: thinkingVal,
          idle: idleVal,
          tiltX: curTilt.x,
          tiltY: curTilt.y,
          paletteKey: resolvePaletteKey(curState),
        });
      }

      // Continuous fluid animation: never freeze completely, maintain gentle ambient drift
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      isDisposed = true;
      window.cancelAnimationFrame(rafId);
    };
  }, [size]);

  const handlePointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
    const ny = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
    targetTiltRef.current = {
      x: clamp(nx, -1, 1),
      y: clamp(ny, -1, 1),
    };
  };

  const handlePointerLeave = () => {
    targetTiltRef.current = { x: 0, y: 0 };
  };

  const Tag: React.ElementType = interactive ? 'button' : 'div';
  const styleVars = {
    '--orb-size': `${size}px`,
  } as React.CSSProperties;

  return (
    <Tag
      ref={rootRef as React.Ref< never >}
      type={interactive ? 'button' : undefined}
      className={[
        'zed-orb',
        `zed-orb--${state}`,
        interactive ? 'zed-orb--interactive' : '',
        hasWebGL ? 'zed-orb--webgl' : 'zed-orb--fallback',
      ]
        .filter(Boolean)
        .join(' ')}
      style={styleVars}
      onClick={onClick}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
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

export default ZedOrb;
