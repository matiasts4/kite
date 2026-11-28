import React, { useEffect, useRef } from 'react';
import { DEFAULT_VOICE_GLOW_PALETTE, type VoiceGlowPalette } from './composerVoiceGlowShader';

export interface VoiceWaveRibbonProps {
  active?: boolean;
  level: number;
  speaking: boolean;
  speaker?: 'you' | 'agent' | 'idle';
  muted?: boolean;
  compact?: boolean;
  palette?: VoiceGlowPalette;
  className?: string;
}

type RgbTuple = [number, number, number];

interface HarmonicLayer {
  freqA: number;
  freqB: number;
  speedA: number;
  speedB: number;
  ampScale: number;
  phaseOffset: number;
  lineWidthHero: number;
  lineWidthCompact: number;
  alphaHero: number;
  alphaCompact: number;
  tone: 'deep' | 'core' | 'glint';
  fillUnderneath?: boolean;
}

const HARMONIC_LAYERS: readonly HarmonicLayer[] = [
  {
    freqA: 2.1,
    freqB: 4.3,
    speedA: 1.55,
    speedB: -2.1,
    ampScale: 0.96,
    phaseOffset: 0.0,
    lineWidthHero: 2.6,
    lineWidthCompact: 1.9,
    alphaHero: 0.42,
    alphaCompact: 0.38,
    tone: 'deep',
    fillUnderneath: true,
  },
  {
    freqA: 3.15,
    freqB: 6.4,
    speedA: 2.4,
    speedB: 3.1,
    ampScale: 1.0,
    phaseOffset: 1.45,
    lineWidthHero: 2.2,
    lineWidthCompact: 1.65,
    alphaHero: 0.94,
    alphaCompact: 0.88,
    tone: 'core',
  },
  {
    freqA: 4.9,
    freqB: 8.6,
    speedA: -3.25,
    speedB: 4.35,
    ampScale: 0.64,
    phaseOffset: 2.85,
    lineWidthHero: 1.2,
    lineWidthCompact: 1.0,
    alphaHero: 0.82,
    alphaCompact: 0.72,
    tone: 'glint',
  },
];

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function toRgba(tuple: RgbTuple, alpha: number, isDark: boolean): string {
  const boost = isDark ? 1.0 : 0.84;
  const r = Math.round(clamp01(tuple[0] * boost) * 255);
  const g = Math.round(clamp01(tuple[1] * boost) * 255);
  const b = Math.round(clamp01(tuple[2] * boost) * 255);
  return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha).toFixed(3)})`;
}

function mixTuples(a: RgbTuple, b: RgbTuple, weight: number): RgbTuple {
  const w = clamp01(weight);
  return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
}

function isReducedMotionPreferred(): boolean {
  if (typeof window === 'undefined') return true;
  if (typeof document !== 'undefined' && document.documentElement.getAttribute('data-motion') === 'reduce') {
    return true;
  }
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/**
 * Animated multi-harmonic Canvas 2D acoustic wave ribbon rendered inside the
 * Voice Teleprompter dock in both idle centerpiece (`hero`) and active lyrics (`horizon`) modes.
 */
export const VoiceWaveRibbon: React.FC<VoiceWaveRibbonProps> = ({
  active = true,
  level,
  speaking,
  speaker = 'idle',
  muted = false,
  compact = false,
  palette = DEFAULT_VOICE_GLOW_PALETTE,
  className = '',
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef({
    level: clamp01(level),
    speaking,
    speaker,
    muted,
    compact,
    active,
    palette,
    smoothAmp: muted ? 0.08 : speaking ? 0.56 : 0.24,
    smoothGlow: speaking ? 0.85 : 0.35,
    phase: 0,
  });

  stateRef.current.level = clamp01(level);
  stateRef.current.speaking = speaking;
  stateRef.current.speaker = speaker;
  stateRef.current.muted = muted;
  stateRef.current.compact = compact;
  stateRef.current.active = active;
  stateRef.current.palette = palette;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return undefined;

    let rafId = 0;
    let disposed = false;
    let lastTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

    const drawFrame = (dtSec: number) => {
      if (disposed || !ctx) return;
      const s = stateRef.current;
      const isDark = typeof document === 'undefined' || document.documentElement.getAttribute('data-theme') !== 'light';
      const heightCss = s.compact ? 22 : 68;
      const measuredW = canvas.clientWidth || canvas.parentElement?.clientWidth || 0;
      const widthCss = Math.max(240, Math.round(measuredW || (s.compact ? 460 : 520)));
      const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
      const targetW = Math.round(widthCss * dpr);
      const targetH = Math.round(heightCss * dpr);

      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      const targetAmp = !s.active
        ? 0.04
        : s.muted
          ? 0.07
          : s.speaking
            ? Math.min(0.96, 0.44 + s.level * 0.52)
            : 0.22 + s.level * 0.28;
      const targetGlow = !s.active || s.muted ? 0.14 : s.speaking ? 0.92 : 0.44;
      const lerpFactor = Math.min(1, dtSec * 8.5);
      s.smoothAmp += (targetAmp - s.smoothAmp) * lerpFactor;
      s.smoothGlow += (targetGlow - s.smoothGlow) * lerpFactor;
      s.phase += dtSec * (s.muted ? 0.55 : s.speaking ? 2.55 + s.level * 1.45 : 1.15);

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, widthCss, heightCss);

      const midY = heightCss * 0.52;
      const maxAmpPx = (s.compact ? 7.5 : 22) * s.smoothAmp;
      const userWarmTint: RgbTuple = [0.98, 0.88, 0.72];
      const speakerMix = s.speaker === 'you' ? 0.34 : 0;
      const tones: Record<'deep' | 'core' | 'glint', RgbTuple> = {
        deep: mixTuples(s.palette.deep, userWarmTint, speakerMix * 0.5),
        core: mixTuples(s.palette.core, userWarmTint, speakerMix),
        glint: mixTuples(s.palette.glint, userWarmTint, speakerMix * 0.8),
      };

      const steps = s.compact ? 72 : 96;
      ctx.globalCompositeOperation = isDark ? 'screen' : 'source-over';

      for (const layer of HARMONIC_LAYERS) {
        const primary = tones[layer.tone];
        const nextTone = layer.tone === 'deep' ? tones.core : tones.glint;
        const grad = ctx.createLinearGradient(0, 0, widthCss, 0);
        grad.addColorStop(0, toRgba(primary, 0, isDark));
        grad.addColorStop(0.22, toRgba(primary, (s.compact ? layer.alphaCompact : layer.alphaHero) * 0.85, isDark));
        grad.addColorStop(0.5, toRgba(nextTone, s.compact ? layer.alphaCompact : layer.alphaHero, isDark));
        grad.addColorStop(0.78, toRgba(primary, (s.compact ? layer.alphaCompact : layer.alphaHero) * 0.85, isDark));
        grad.addColorStop(1, toRgba(primary, 0, isDark));

        ctx.beginPath();
        for (let i = 0; i <= steps; i += 1) {
          const u = i / steps;
          const x = u * widthCss;
          const envelope = Math.pow(Math.sin(Math.PI * u), 1.45);
          const waveA = Math.sin(u * Math.PI * layer.freqA - s.phase * layer.speedA + layer.phaseOffset);
          const waveB = Math.cos(u * Math.PI * layer.freqB + s.phase * layer.speedB + layer.phaseOffset * 0.6);
          const y = midY + (waveA * 0.68 + waveB * 0.32) * maxAmpPx * layer.ampScale * envelope;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }

        if (layer.fillUnderneath && !s.compact) {
          ctx.save();
          ctx.lineTo(widthCss, heightCss);
          ctx.lineTo(0, heightCss);
          ctx.closePath();
          const areaGrad = ctx.createLinearGradient(0, midY - maxAmpPx, 0, heightCss);
          areaGrad.addColorStop(0, toRgba(tones.core, 0.16 * s.smoothGlow, isDark));
          areaGrad.addColorStop(1, toRgba(tones.deep, 0, isDark));
          ctx.fillStyle = areaGrad;
          ctx.fill();
          ctx.restore();
          ctx.beginPath();
          for (let i = 0; i <= steps; i += 1) {
            const u = i / steps;
            const x = u * widthCss;
            const envelope = Math.pow(Math.sin(Math.PI * u), 1.45);
            const waveA = Math.sin(u * Math.PI * layer.freqA - s.phase * layer.speedA + layer.phaseOffset);
            const waveB = Math.cos(u * Math.PI * layer.freqB + s.phase * layer.speedB + layer.phaseOffset * 0.6);
            const y = midY + (waveA * 0.68 + waveB * 0.32) * maxAmpPx * layer.ampScale * envelope;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
        }

        ctx.strokeStyle = grad;
        ctx.lineWidth = s.compact ? layer.lineWidthCompact : layer.lineWidthHero;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = toRgba(nextTone, (isDark ? 0.56 : 0.24) * s.smoothGlow, isDark);
        ctx.shadowBlur = layer.tone === 'glint' ? (s.compact ? 6 : 14) : s.compact ? 4 : 9;
        ctx.stroke();
      }
      ctx.restore();
    };

    const tick = (now: number) => {
      if (disposed) return;
      const dtSec = Math.min(0.05, Math.max(0.008, (now - lastTime) / 1000));
      lastTime = now;
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        drawFrame(dtSec);
      }
      if (stateRef.current.active && !isReducedMotionPreferred()) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    drawFrame(0.016);
    if (stateRef.current.active && !isReducedMotionPreferred()) {
      rafId = window.requestAnimationFrame(tick);
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && stateRef.current.active && !isReducedMotionPreferred() && !rafId) {
        lastTime = performance.now();
        rafId = window.requestAnimationFrame(tick);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [active, compact]);

  const heightPx = compact ? 22 : 68;
  return (
    <canvas
      ref={canvasRef}
      data-testid="voice-wave-ribbon"
      data-mode={compact ? 'horizon' : 'hero'}
      data-speaker={speaker}
      data-muted={muted ? 'true' : 'false'}
      aria-hidden="true"
      className={className ? `kite-voice-wave-ribbon ${className}` : 'kite-voice-wave-ribbon'}
      style={{ width: '100%', height: `${heightPx}px`, display: 'block' }}
    />
  );
};
