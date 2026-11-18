import React, { useEffect, useState } from 'react';
import {
  getActivePaletteForState,
  getThemePackById,
  readThemeCustomizations,
  resolveEffectiveHeroFigure,
  type ConcreteHeroFigureId,
  type HeroFigureId,
  type KiteThemeCustomizations,
} from '../../lib/themeCustomizations';

export interface ThemeHeroFigureProps {
  figure?: HeroFigureId;
  paletteId?: string;
  variant?: 'hero' | 'miniature' | 'watermark' | 'card';
  className?: string;
}

export const ThemeHeroFigure: React.FC<ThemeHeroFigureProps> = ({
  figure,
  paletteId,
  variant = 'hero',
  className = '',
}) => {
  const [liveState, setLiveState] = useState<KiteThemeCustomizations>(() =>
    readThemeCustomizations()
  );

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

  const resolvedFigure: ConcreteHeroFigureId =
    !figure || figure === 'theme-default'
      ? resolveEffectiveHeroFigure(liveState, pack)
      : figure;

  if (resolvedFigure === 'none') {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className={`theme-hero-figure theme-hero-figure--${variant} theme-hero-figure--${resolvedFigure} ${className}`.trim()}
      data-figure-style={resolvedFigure}
      data-testid={`theme-hero-figure-${resolvedFigure}`}
    >
      <div className="theme-hero-figure__halo" />
      {resolvedFigure === 'pixel-companion' && <PixelCompanionSvg />}
      {resolvedFigure === 'isometric-construct' && <IsometricConstructSvg />}
      {resolvedFigure === 'editorial-botanical' && <EditorialBotanicalSvg />}
      {resolvedFigure === 'orbital-constellation' && <OrbitalConstellationSvg />}
      {resolvedFigure === 'kite-crest' && <KiteCrestSvg />}
    </div>
  );
};

const PixelCompanionSvg: React.FC = () => (
  <svg
    className="theme-hero-figure__svg"
    viewBox="0 0 120 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <ellipse cx="60" cy="88" rx="28" ry="5" fill="var(--accent, #5c8fff)" fillOpacity="0.18" />
    <rect x="14" y="28" width="10" height="4" rx="1" fill="var(--accent, #5c8fff)" fillOpacity="0.55" />
    <rect x="18" y="36" width="6" height="4" rx="1" fill="var(--text-secondary, #94a3b8)" fillOpacity="0.4" />
    <rect x="96" y="24" width="10" height="4" rx="1" fill="var(--accent, #5c8fff)" fillOpacity="0.55" />
    <rect x="94" y="32" width="8" height="4" rx="1" fill="var(--text-secondary, #94a3b8)" fillOpacity="0.4" />
    <rect x="57" y="10" width="6" height="10" fill="var(--text-secondary, #94a3b8)" />
    <rect x="55" y="6" width="10" height="6" fill="var(--accent, #5c8fff)" />
    <rect x="32" y="20" width="56" height="42" rx="4" fill="var(--pane, #181825)" stroke="var(--accent, #5c8fff)" strokeWidth="2.5" />
    <rect x="38" y="26" width="44" height="24" rx="2" fill="var(--background, #090a0c)" />
    <rect x="45" y="33" width="8" height="10" fill="var(--accent, #5c8fff)" />
    <rect x="47" y="35" width="3" height="3" fill="#ffffff" />
    <rect x="67" y="33" width="8" height="10" fill="var(--accent, #5c8fff)" />
    <rect x="69" y="35" width="3" height="3" fill="#ffffff" />
    <rect x="52" y="54" width="16" height="3" fill="var(--accent, #5c8fff)" fillOpacity="0.75" />
    <rect x="26" y="32" width="6" height="14" fill="var(--accent, #5c8fff)" fillOpacity="0.7" />
    <rect x="88" y="32" width="6" height="14" fill="var(--accent, #5c8fff)" fillOpacity="0.7" />
    <rect x="40" y="62" width="40" height="16" rx="2" fill="var(--pane, #181825)" stroke="var(--text-secondary, #94a3b8)" strokeWidth="2" strokeOpacity="0.6" />
    <rect x="46" y="67" width="10" height="6" fill="var(--accent, #5c8fff)" fillOpacity="0.85" />
    <rect x="60" y="68" width="14" height="4" fill="var(--text-secondary, #94a3b8)" fillOpacity="0.5" />
    <rect x="42" y="78" width="10" height="7" fill="var(--text-primary, #f3f4f6)" fillOpacity="0.8" />
    <rect x="68" y="78" width="10" height="7" fill="var(--text-primary, #f3f4f6)" fillOpacity="0.8" />
  </svg>
);

const IsometricConstructSvg: React.FC = () => (
  <svg
    className="theme-hero-figure__svg"
    viewBox="0 0 120 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M60 88L18 66L60 44L102 66L60 88Z"
      stroke="var(--accent, #5c8fff)"
      strokeOpacity="0.3"
      strokeWidth="1.5"
      fill="var(--accent, #5c8fff)"
      fillOpacity="0.06"
    />
    <path
      d="M60 14L94 32V68L60 86L26 68V32L60 14Z"
      stroke="var(--text-secondary, #94a3b8)"
      strokeOpacity="0.45"
      strokeWidth="1.5"
    />
    <path
      d="M60 22L86 36L60 50L34 36L60 22Z"
      fill="var(--accent, #5c8fff)"
      fillOpacity="0.24"
      stroke="var(--accent, #5c8fff)"
      strokeWidth="1.75"
    />
    <path
      d="M34 36L60 50V78L34 64V36Z"
      fill="var(--pane, #181825)"
      fillOpacity="0.85"
      stroke="var(--accent, #5c8fff)"
      strokeWidth="1.75"
    />
    <path
      d="M86 36L60 50V78L86 64V36Z"
      fill="var(--accent, #5c8fff)"
      fillOpacity="0.14"
      stroke="var(--accent, #5c8fff)"
      strokeWidth="1.75"
    />
    <circle cx="60" cy="50" r="6" fill="var(--accent, #5c8fff)" />
    <circle cx="60" cy="22" r="3" fill="var(--text-primary, #f3f4f6)" />
    <circle cx="34" cy="36" r="2.5" fill="var(--accent, #5c8fff)" />
    <circle cx="86" cy="36" r="2.5" fill="var(--accent, #5c8fff)" />
  </svg>
);

const EditorialBotanicalSvg: React.FC = () => (
  <svg
    className="theme-hero-figure__svg"
    viewBox="0 0 120 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M34 86V46C34 31.6406 45.6406 20 60 20C74.3594 20 86 31.6406 86 46V86"
      stroke="var(--accent, #d97757)"
      strokeOpacity="0.45"
      strokeWidth="1.5"
    />
    <circle
      cx="60"
      cy="38"
      r="10"
      fill="var(--accent, #d97757)"
      fillOpacity="0.22"
      stroke="var(--accent, #d97757)"
      strokeWidth="1.75"
    />
    <path
      d="M60 86C60 68 60 52 60 38"
      stroke="var(--text-primary, #f5f2eb)"
      strokeWidth="1.75"
      strokeLinecap="round"
    />
    <path
      d="M60 68C48 66 42 58 44 50C52 50 58 58 60 68Z"
      fill="var(--accent, #d97757)"
      fillOpacity="0.28"
      stroke="var(--accent, #d97757)"
      strokeWidth="1.5"
    />
    <path
      d="M60 58C72 56 78 48 76 40C68 40 62 48 60 58Z"
      fill="var(--accent, #d97757)"
      fillOpacity="0.28"
      stroke="var(--accent, #d97757)"
      strokeWidth="1.5"
    />
    <path
      d="M24 30L26 35L31 37L26 39L24 44L22 39L17 37L22 35L24 30Z"
      fill="var(--accent, #d97757)"
      fillOpacity="0.75"
    />
    <path
      d="M96 26L97.5 30L101.5 31.5L97.5 33L96 37L94.5 33L90.5 31.5L94.5 30L96 26Z"
      fill="var(--accent, #d97757)"
      fillOpacity="0.75"
    />
  </svg>
);

const OrbitalConstellationSvg: React.FC = () => (
  <svg
    className="theme-hero-figure__svg"
    viewBox="0 0 120 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle
      cx="60"
      cy="50"
      r="36"
      stroke="var(--accent, #38bdf8)"
      strokeOpacity="0.28"
      strokeWidth="1.25"
      strokeDasharray="4 4"
    />
    <ellipse
      cx="60"
      cy="50"
      rx="38"
      ry="16"
      transform="rotate(-24 60 50)"
      stroke="var(--accent, #38bdf8)"
      strokeOpacity="0.65"
      strokeWidth="1.5"
    />
    <ellipse
      cx="60"
      cy="50"
      rx="38"
      ry="16"
      transform="rotate(32 60 50)"
      stroke="var(--text-secondary, #94a3b8)"
      strokeOpacity="0.45"
      strokeWidth="1.5"
    />
    <path
      d="M32 58L50 36L68 62L88 40"
      stroke="var(--accent, #38bdf8)"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="60" cy="50" r="7" fill="var(--accent, #38bdf8)" fillOpacity="0.25" />
    <circle cx="60" cy="50" r="3.5" fill="var(--text-primary, #f8fafc)" />
    <circle cx="32" cy="58" r="3.5" fill="var(--accent, #38bdf8)" />
    <circle cx="50" cy="36" r="4" fill="var(--accent, #38bdf8)" />
    <circle cx="68" cy="62" r="4" fill="var(--accent, #38bdf8)" />
    <circle cx="88" cy="40" r="3.5" fill="var(--accent, #38bdf8)" />
  </svg>
);

const KiteCrestSvg: React.FC = () => (
  <svg
    className="theme-hero-figure__svg"
    viewBox="0 0 120 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M60 12L28 44L60 62V12Z"
      fill="var(--accent, #5c8fff)"
      fillOpacity="0.32"
      stroke="var(--accent, #5c8fff)"
      strokeWidth="1.75"
      strokeLinejoin="round"
    />
    <path
      d="M60 12L92 44L60 62V12Z"
      fill="var(--accent, #5c8fff)"
      fillOpacity="0.16"
      stroke="var(--accent, #5c8fff)"
      strokeWidth="1.75"
      strokeLinejoin="round"
    />
    <path
      d="M28 44L60 84L60 62L28 44Z"
      fill="var(--pane, #0d0f12)"
      stroke="var(--accent, #5c8fff)"
      strokeWidth="1.75"
      strokeLinejoin="round"
    />
    <path
      d="M92 44L60 84L60 62L92 44Z"
      fill="var(--accent, #5c8fff)"
      fillOpacity="0.24"
      stroke="var(--accent, #5c8fff)"
      strokeWidth="1.75"
      strokeLinejoin="round"
    />
    <path
      d="M60 84C63 90 70 92 76 89"
      stroke="var(--accent, #5c8fff)"
      strokeWidth="1.75"
      strokeLinecap="round"
    />
    <circle cx="60" cy="44" r="3.5" fill="var(--text-primary, #f3f4f6)" />
  </svg>
);
