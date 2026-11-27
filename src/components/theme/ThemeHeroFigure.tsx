import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  getActivePaletteForState,
  getThemePackById,
  readThemeCustomizations,
  resolveEffectiveHeroFigure,
  type ConcreteHeroFigureId,
  type HeroFigureId,
  type KiteThemeCustomizations,
} from '../../lib/themeCustomizations';
import {
  EditorialBotanicalSvg,
  IsometricConstructSvg,
  KineticRingSvg,
  KiteCrestSvg,
  OrbitalConstellationSvg,
  PixelCompanionSvg,
} from './heroFigures';

export type FigureVoiceState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'muted'
  | 'error';

export type FigureMood = 'idle' | 'greeting' | 'curious' | 'excited';
export type FigureReaction = 'idle' | 'greeting' | 'excited';

export interface ThemeHeroFigureProps {
  figure?: HeroFigureId;
  fallbackFigure?: Exclude<ConcreteHeroFigureId, 'none'>;
  paletteId?: string;
  variant?: 'hero' | 'miniature' | 'watermark' | 'card' | 'assistant';
  voiceState?: FigureVoiceState;
  voiceLevel?: number;
  mood?: FigureMood;
  triggerKey?: string | number;
  interactive?: boolean;
  className?: string;
}

const GREETING_DURATION_MS = 1650;
const EXCITED_DURATION_MS = 1350;

export const ThemeHeroFigure: React.FC<ThemeHeroFigureProps> = ({
  figure,
  fallbackFigure,
  paletteId,
  variant = 'hero',
  voiceState = 'idle',
  voiceLevel = 0,
  mood = 'idle',
  triggerKey,
  interactive,
  className = '',
}) => {
  const uid = useId().replace(/:/g, '');
  const isHero = variant === 'hero';
  const isInteractive = interactive ?? isHero;

  const [liveState, setLiveState] = useState<KiteThemeCustomizations>(() =>
    readThemeCustomizations()
  );
  const [reaction, setReaction] = useState<FigureReaction>(() =>
    isHero ? 'greeting' : 'idle'
  );
  const [burstCount, setBurstCount] = useState(0);
  const [gaze, setGaze] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const reactionTimerRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const scheduleReactionReset = useCallback((durationMs: number) => {
    if (reactionTimerRef.current !== null) {
      window.clearTimeout(reactionTimerRef.current);
    }
    reactionTimerRef.current = window.setTimeout(() => {
      reactionTimerRef.current = null;
      setReaction('idle');
    }, durationMs);
  }, []);

  useEffect(() => {
    if (!isHero) {
      setReaction('idle');
      return;
    }
    setReaction('greeting');
    scheduleReactionReset(GREETING_DURATION_MS);
    return () => {
      if (reactionTimerRef.current !== null) {
        window.clearTimeout(reactionTimerRef.current);
        reactionTimerRef.current = null;
      }
    };
  }, [isHero, triggerKey, scheduleReactionReset]);

  useEffect(() => {
    if (figure && figure !== 'theme-default') return;
    const handleUpdate = (e: Event) => {
      const detail = (e as CustomEvent<{ customizations?: KiteThemeCustomizations }>).detail;
      if (detail?.customizations) {
        setLiveState(detail.customizations);
      } else {
        setLiveState(readThemeCustomizations());
      }
    };
    window.addEventListener('kite:theme-changed', handleUpdate);
    return () => window.removeEventListener('kite:theme-changed', handleUpdate);
  }, [figure]);

  const effectivePaletteId = paletteId ?? getActivePaletteForState(liveState);
  const pack = getThemePackById(effectivePaletteId);

  const rawResolved: ConcreteHeroFigureId =
    !figure || figure === 'theme-default'
      ? resolveEffectiveHeroFigure(liveState, pack)
      : figure;

  const resolvedFigure: ConcreteHeroFigureId =
    rawResolved === 'none' && fallbackFigure ? fallbackFigure : rawResolved;

  if (resolvedFigure === 'none') {
    return null;
  }

  const clampedLevel = Math.max(0, Math.min(1, Number.isFinite(voiceLevel) ? voiceLevel : 0));

  const triggerExcited = () => {
    if (!isInteractive) return;
    setBurstCount((c) => c + 1);
    setReaction('excited');
    scheduleReactionReset(EXCITED_DURATION_MS);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isInteractive || !rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = Math.max(-1, Math.min(1, ((e.clientX - rect.left) / rect.width) * 2 - 1));
    const ny = Math.max(-1, Math.min(1, ((e.clientY - rect.top) / rect.height) * 2 - 1));
    setGaze({ x: Number(nx.toFixed(2)), y: Number(ny.toFixed(2)) });
  };

  const handlePointerLeave = () => {
    if (!isInteractive) return;
    setGaze({ x: 0, y: 0 });
  };

  const svgProps = {
    uid,
    voiceState,
    reaction,
    mood,
  };

  return (
    <div
      ref={rootRef}
      aria-hidden={isInteractive ? undefined : true}
      aria-label={isInteractive ? 'Interactuar con la figura de portada' : undefined}
      className={`theme-hero-figure theme-hero-figure--${variant} theme-hero-figure--${resolvedFigure} ${
        isInteractive ? 'theme-hero-figure--interactive' : ''
      } ${className}`.trim()}
      data-burst={burstCount}
      data-figure-style={resolvedFigure}
      data-interactive={isInteractive ? 'true' : 'false'}
      data-mood={mood}
      data-reaction={reaction}
      data-testid={`theme-hero-figure-${resolvedFigure}`}
      data-voice-state={voiceState}
      onClick={isInteractive ? triggerExcited : undefined}
      onKeyDown={
        isInteractive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                triggerExcited();
              }
            }
          : undefined
      }
      onPointerLeave={isInteractive ? handlePointerLeave : undefined}
      onPointerMove={isInteractive ? handlePointerMove : undefined}
      role={isInteractive ? 'button' : undefined}
      style={
        {
          '--voice-level': clampedLevel.toFixed(3),
          '--gaze-x': String(gaze.x),
          '--gaze-y': String(gaze.y),
        } as React.CSSProperties
      }
      tabIndex={isInteractive ? 0 : undefined}
      title={isInteractive ? 'Haz clic para saludar' : undefined}
    >
      <div className="theme-hero-figure__halo" />
      <div key={`${resolvedFigure}-${burstCount}-${String(triggerKey ?? '')}`} className="theme-hero-figure__stage">
        {resolvedFigure === 'pixel-companion' && <PixelCompanionSvg {...svgProps} />}
        {resolvedFigure === 'isometric-construct' && <IsometricConstructSvg {...svgProps} />}
        {resolvedFigure === 'editorial-botanical' && <EditorialBotanicalSvg {...svgProps} />}
        {resolvedFigure === 'orbital-constellation' && <OrbitalConstellationSvg {...svgProps} />}
        {resolvedFigure === 'kite-crest' && <KiteCrestSvg {...svgProps} />}
        {resolvedFigure === 'kinetic-ring' && <KineticRingSvg {...svgProps} />}
      </div>
    </div>
  );
};
