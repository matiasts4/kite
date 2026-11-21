import React, { useEffect, useId, useState } from 'react';
import {
  getActivePaletteForState,
  getThemePackById,
  readThemeCustomizations,
  resolveEffectiveHeroFigure,
  type ConcreteHeroFigureId,
  type HeroFigureId,
  type KiteThemeCustomizations,
} from '../../lib/themeCustomizations';

export type FigureVoiceState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'muted'
  | 'error';

export interface ThemeHeroFigureProps {
  figure?: HeroFigureId;
  fallbackFigure?: Exclude<ConcreteHeroFigureId, 'none'>;
  paletteId?: string;
  variant?: 'hero' | 'miniature' | 'watermark' | 'card' | 'assistant';
  voiceState?: FigureVoiceState;
  voiceLevel?: number;
  className?: string;
}

export const ThemeHeroFigure: React.FC<ThemeHeroFigureProps> = ({
  figure,
  fallbackFigure,
  paletteId,
  variant = 'hero',
  voiceState = 'idle',
  voiceLevel = 0,
  className = '',
}) => {
  const uid = useId().replace(/:/g, '');
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

  return (
    <div
      aria-hidden="true"
      className={`theme-hero-figure theme-hero-figure--${variant} theme-hero-figure--${resolvedFigure} ${className}`.trim()}
      data-figure-style={resolvedFigure}
      data-voice-state={voiceState}
      data-testid={`theme-hero-figure-${resolvedFigure}`}
      style={{ '--voice-level': clampedLevel.toFixed(3) } as React.CSSProperties}
    >
      <div className="theme-hero-figure__halo" />
      {resolvedFigure === 'pixel-companion' && (
        <PixelCompanionSvg uid={uid} voiceState={voiceState} />
      )}
      {resolvedFigure === 'isometric-construct' && <IsometricConstructSvg uid={uid} />}
      {resolvedFigure === 'editorial-botanical' && <EditorialBotanicalSvg uid={uid} />}
      {resolvedFigure === 'orbital-constellation' && <OrbitalConstellationSvg uid={uid} />}
      {resolvedFigure === 'kite-crest' && <KiteCrestSvg uid={uid} />}
      {resolvedFigure === 'kinetic-ring' && (
        <KineticRingSvg uid={uid} voiceState={voiceState} />
      )}
    </div>
  );
};

interface FigureSvgProps {
  uid: string;
  voiceState?: FigureVoiceState;
}

const KiteCrestSvg: React.FC<FigureSvgProps> = ({ uid }) => (
  <svg
    className="theme-hero-figure__svg"
    viewBox="0 0 120 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <linearGradient id={`kc-left-${uid}`} x1="28" y1="14" x2="60" y2="62" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="var(--accent, #5c8fff)" stopOpacity="0.62" />
        <stop offset="100%" stopColor="var(--accent, #5c8fff)" stopOpacity="0.16" />
      </linearGradient>
      <linearGradient id={`kc-right-${uid}`} x1="60" y1="14" x2="92" y2="62" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="var(--text-primary, #f3f4f6)" stopOpacity="0.34" />
        <stop offset="100%" stopColor="var(--accent, #5c8fff)" stopOpacity="0.08" />
      </linearGradient>
      <linearGradient id={`kc-lower-${uid}`} x1="60" y1="44" x2="92" y2="82" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="var(--accent, #5c8fff)" stopOpacity="0.36" />
        <stop offset="100%" stopColor="var(--pane, #0d0f12)" stopOpacity="0.88" />
      </linearGradient>
    </defs>

    {/* Architectural calibration reticle */}
    <circle
      className="theme-hero-figure__orbit"
      cx="60"
      cy="48"
      r="40"
      stroke="var(--accent, #5c8fff)"
      strokeOpacity="0.22"
      strokeWidth="1"
      strokeDasharray="3 5"
    />
    <path
      d="M60 4V9M60 87V92M16 48H21M99 48H104"
      stroke="var(--text-secondary, #94a3b8)"
      strokeOpacity="0.35"
      strokeWidth="1.2"
      strokeLinecap="round"
    />

    {/* Faceted origami kite prism */}
    <path
      d="M60 12L28 45L60 60V12Z"
      fill={`url(#kc-left-${uid})`}
      stroke="var(--accent, #5c8fff)"
      strokeWidth="1.65"
      strokeLinejoin="round"
    />
    <path
      d="M60 12L92 45L60 60V12Z"
      fill={`url(#kc-right-${uid})`}
      stroke="var(--accent, #5c8fff)"
      strokeWidth="1.65"
      strokeLinejoin="round"
    />
    <path
      d="M28 45L60 82V60L28 45Z"
      fill="var(--pane, #0d0f12)"
      fillOpacity="0.86"
      stroke="var(--accent, #5c8fff)"
      strokeWidth="1.65"
      strokeLinejoin="round"
    />
    <path
      d="M92 45L60 82V60L92 45Z"
      fill={`url(#kc-lower-${uid})`}
      stroke="var(--accent, #5c8fff)"
      strokeWidth="1.65"
      strokeLinejoin="round"
    />

    {/* Inner luminous ridge & kite tail */}
    <path
      d="M60 19L40 45L60 54L80 45L60 19Z"
      stroke="var(--text-primary, #f3f4f6)"
      strokeOpacity="0.28"
      strokeWidth="1"
      strokeLinejoin="round"
    />
    <path
      d="M60 82C63 89 72 91 81 87"
      stroke="var(--accent, #5c8fff)"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <path
      d="M84 84.5L86.5 87L84 89.5L81.5 87L84 84.5Z"
      fill="var(--accent, #5c8fff)"
    />

    {/* Reactive core beacon */}
    <circle
      className="theme-hero-figure__pulse-core"
      cx="60"
      cy="45"
      r="7"
      fill="var(--accent, #5c8fff)"
      fillOpacity="0.24"
    />
    <circle cx="60" cy="45" r="3.4" fill="var(--text-primary, #f8fafc)" />
  </svg>
);

const KineticRingSvg: React.FC<FigureSvgProps> = ({ uid, voiceState = 'idle' }) => (
  <svg
    className="theme-hero-figure__svg"
    viewBox="0 0 120 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <linearGradient id={`kr-arc-${uid}`} x1="22" y1="16" x2="98" y2="84" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="var(--accent, #5c8fff)" stopOpacity="0.95" />
        <stop offset="100%" stopColor="var(--accent, #5c8fff)" stopOpacity="0.18" />
      </linearGradient>
    </defs>

    {/* Outer architectural segmented ring */}
    <g className="theme-hero-figure__orbit">
      <circle
        cx="60"
        cy="50"
        r="39"
        stroke="var(--accent, #5c8fff)"
        strokeOpacity="0.22"
        strokeWidth="1.2"
        strokeDasharray="16 8 4 8"
      />
      <path
        d="M60 11A39 39 0 0 1 97 38"
        stroke={`url(#kr-arc-${uid})`}
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M60 89A39 39 0 0 1 23 62"
        stroke="var(--text-secondary, #94a3b8)"
        strokeOpacity="0.5"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </g>

    {/* Counter-rotating precision bezel */}
    <g className="theme-hero-figure__orbit-reverse">
      <circle
        cx="60"
        cy="50"
        r="28"
        stroke="var(--accent, #5c8fff)"
        strokeOpacity="0.45"
        strokeWidth="1.35"
        strokeDasharray="44 18 14 16"
      />
      <circle cx="88" cy="50" r="2.6" fill="var(--accent, #5c8fff)" />
      <circle cx="32" cy="50" r="2" fill="var(--text-primary, #f3f4f6)" fillOpacity="0.7" />
    </g>

    {/* Glass disc core */}
    <circle
      cx="60"
      cy="50"
      r="19"
      fill="var(--pane, #0d0f12)"
      fillOpacity="0.88"
      stroke="var(--accent, #5c8fff)"
      strokeOpacity="0.38"
      strokeWidth="1.35"
    />

    {/* Harmonic core: diamond when idle, 5-bar precision spectrum when voice active */}
    {voiceState === 'idle' ? (
      <g>
        <path
          d="M60 39L70 50L60 61L50 50L60 39Z"
          fill="var(--accent, #5c8fff)"
          fillOpacity="0.22"
          stroke="var(--accent, #5c8fff)"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <circle cx="60" cy="50" r="3" fill="var(--text-primary, #f8fafc)" />
      </g>
    ) : voiceState === 'muted' ? (
      <g stroke="var(--status-failed, #ef4444)" strokeWidth="2" strokeLinecap="round">
        <line x1="53" y1="43" x2="67" y2="57" />
        <line x1="67" y1="43" x2="53" y2="57" />
      </g>
    ) : (
      <g className="theme-hero-figure__bars">
        <rect className="theme-hero-figure__bar" x="49" y="45" width="2.6" height="10" rx="1.3" fill="var(--accent, #5c8fff)" />
        <rect className="theme-hero-figure__bar" x="54" y="41" width="2.6" height="18" rx="1.3" fill="var(--accent, #5c8fff)" />
        <rect className="theme-hero-figure__bar" x="58.7" y="38" width="2.6" height="24" rx="1.3" fill="var(--text-primary, #f8fafc)" />
        <rect className="theme-hero-figure__bar" x="63.4" y="41" width="2.6" height="18" rx="1.3" fill="var(--accent, #5c8fff)" />
        <rect className="theme-hero-figure__bar" x="68.4" y="45" width="2.6" height="10" rx="1.3" fill="var(--accent, #5c8fff)" />
      </g>
    )}
  </svg>
);

const OrbitalConstellationSvg: React.FC<FigureSvgProps> = ({ uid }) => (
  <svg
    className="theme-hero-figure__svg"
    viewBox="0 0 120 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <linearGradient id={`oc-ring-${uid}`} x1="22" y1="30" x2="98" y2="70" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="var(--accent, #38bdf8)" stopOpacity="0.88" />
        <stop offset="100%" stopColor="var(--accent, #38bdf8)" stopOpacity="0.16" />
      </linearGradient>
    </defs>

    <circle
      className="theme-hero-figure__orbit"
      cx="60"
      cy="50"
      r="38"
      stroke="var(--accent, #38bdf8)"
      strokeOpacity="0.24"
      strokeWidth="1.2"
      strokeDasharray="3 5"
    />
    <ellipse
      className="theme-hero-figure__orbit"
      cx="60"
      cy="50"
      rx="40"
      ry="15.5"
      transform="rotate(-24 60 50)"
      stroke={`url(#oc-ring-${uid})`}
      strokeWidth="1.5"
    />
    <ellipse
      className="theme-hero-figure__orbit-reverse"
      cx="60"
      cy="50"
      rx="38"
      ry="15.5"
      transform="rotate(30 60 50)"
      stroke="var(--text-secondary, #94a3b8)"
      strokeOpacity="0.45"
      strokeWidth="1.3"
    />

    {/* Constellation links */}
    <path
      d="M31 58L49 34L68 62L89 39"
      stroke="var(--accent, #38bdf8)"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M49 34L89 39"
      stroke="var(--accent, #38bdf8)"
      strokeOpacity="0.28"
      strokeWidth="1"
      strokeDasharray="2 3"
    />

    {/* Central beacon */}
    <circle
      className="theme-hero-figure__pulse-core"
      cx="60"
      cy="50"
      r="9"
      fill="var(--accent, #38bdf8)"
      fillOpacity="0.22"
    />
    <circle cx="60" cy="50" r="4" fill="var(--text-primary, #f8fafc)" />

    {/* Star nodes */}
    <circle cx="31" cy="58" r="3.2" fill="var(--pane, #0d1424)" stroke="var(--accent, #38bdf8)" strokeWidth="1.6" />
    <circle cx="49" cy="34" r="3.8" fill="var(--accent, #38bdf8)" />
    <circle cx="68" cy="62" r="3.8" fill="var(--accent, #38bdf8)" />
    <circle cx="89" cy="39" r="3.2" fill="var(--pane, #0d1424)" stroke="var(--accent, #38bdf8)" strokeWidth="1.6" />
  </svg>
);

const IsometricConstructSvg: React.FC<FigureSvgProps> = ({ uid }) => (
  <svg
    className="theme-hero-figure__svg"
    viewBox="0 0 120 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <linearGradient id={`ic-top-${uid}`} x1="34" y1="22" x2="86" y2="50" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="var(--accent, #5c8fff)" stopOpacity="0.48" />
        <stop offset="100%" stopColor="var(--accent, #5c8fff)" stopOpacity="0.16" />
      </linearGradient>
      <linearGradient id={`ic-right-${uid}`} x1="60" y1="50" x2="86" y2="78" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="var(--accent, #5c8fff)" stopOpacity="0.28" />
        <stop offset="100%" stopColor="var(--pane, #181825)" stopOpacity="0.88" />
      </linearGradient>
    </defs>

    {/* Architectural base platform */}
    <path
      d="M60 90L18 68L60 46L102 68L60 90Z"
      stroke="var(--accent, #5c8fff)"
      strokeOpacity="0.32"
      strokeWidth="1.35"
      fill="var(--accent, #5c8fff)"
      fillOpacity="0.06"
    />
    {/* Wireframe outer cage */}
    <path
      d="M60 12L94 30V68L60 86L26 68V30L60 12Z"
      stroke="var(--text-secondary, #94a3b8)"
      strokeOpacity="0.38"
      strokeWidth="1.25"
      strokeDasharray="4 3"
    />

    {/* Solid 3-face isometric monolith */}
    <path
      d="M60 21L86 35L60 49L34 35L60 21Z"
      fill={`url(#ic-top-${uid})`}
      stroke="var(--accent, #5c8fff)"
      strokeWidth="1.65"
      strokeLinejoin="round"
    />
    <path
      d="M34 35L60 49V78L34 64V35Z"
      fill="var(--pane, #181825)"
      fillOpacity="0.9"
      stroke="var(--accent, #5c8fff)"
      strokeWidth="1.65"
      strokeLinejoin="round"
    />
    <path
      d="M86 35L60 49V78L86 64V35Z"
      fill={`url(#ic-right-${uid})`}
      stroke="var(--accent, #5c8fff)"
      strokeWidth="1.65"
      strokeLinejoin="round"
    />

    {/* Inner levitating prism core */}
    <path
      className="theme-hero-figure__pulse-core"
      d="M60 39L70 49L60 59L50 49L60 39Z"
      fill="var(--accent, #5c8fff)"
      fillOpacity="0.32"
      stroke="var(--text-primary, #f3f4f6)"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
    <circle cx="60" cy="49" r="3" fill="var(--text-primary, #f3f4f6)" />
    <circle cx="60" cy="21" r="2.6" fill="var(--text-primary, #f3f4f6)" />
    <circle cx="34" cy="35" r="2.2" fill="var(--accent, #5c8fff)" />
    <circle cx="86" cy="35" r="2.2" fill="var(--accent, #5c8fff)" />
  </svg>
);

const PixelCompanionSvg: React.FC<FigureSvgProps> = ({ uid, voiceState = 'idle' }) => {
  const isMuted = voiceState === 'muted' || voiceState === 'error';
  const isSpeaking = voiceState === 'speaking';
  const isThinking = voiceState === 'thinking' || voiceState === 'transcribing';

  return (
    <svg
      className="theme-hero-figure__svg"
      viewBox="0 0 120 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={`px-body-${uid}`} x1="32" y1="20" x2="88" y2="76" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--pane, #181825)" stopOpacity="0.98" />
          <stop offset="100%" stopColor="var(--background, #090a0c)" stopOpacity="0.95" />
        </linearGradient>
      </defs>

      {/* Ground shadow */}
      <ellipse cx="60" cy="89" rx="28" ry="4.5" fill="var(--accent, #5c8fff)" fillOpacity="0.2" />

      {/* Signal ticks */}
      <rect x="14" y="29" width="9" height="3.5" rx="1" fill="var(--accent, #5c8fff)" fillOpacity="0.6" />
      <rect x="18" y="36" width="5" height="3.5" rx="1" fill="var(--text-secondary, #94a3b8)" fillOpacity="0.45" />
      <rect x="97" y="25" width="9" height="3.5" rx="1" fill="var(--accent, #5c8fff)" fillOpacity="0.6" />
      <rect x="95" y="32" width="7" height="3.5" rx="1" fill="var(--text-secondary, #94a3b8)" fillOpacity="0.45" />

      {/* Antenna */}
      <rect x="57.5" y="11" width="5" height="9" rx="1" fill="var(--text-secondary, #94a3b8)" />
      <rect
        className="theme-hero-figure__pulse-core"
        x="55"
        y="6"
        width="10"
        height="6"
        rx="2"
        fill={isMuted ? 'var(--status-failed, #ef4444)' : 'var(--accent, #5c8fff)'}
      />

      {/* Head chassis */}
      <rect
        x="31"
        y="20"
        width="58"
        height="43"
        rx="7"
        fill={`url(#px-body-${uid})`}
        stroke={isMuted ? 'var(--status-failed, #ef4444)' : 'var(--accent, #5c8fff)'}
        strokeWidth="2.2"
      />
      {/* Ear couplers */}
      <rect x="25" y="33" width="6" height="15" rx="2" fill="var(--accent, #5c8fff)" fillOpacity="0.68" />
      <rect x="89" y="33" width="6" height="15" rx="2" fill="var(--accent, #5c8fff)" fillOpacity="0.68" />

      {/* Inner visor screen */}
      <rect
        x="38"
        y="27"
        width="44"
        height="26"
        rx="4"
        fill="var(--background, #090a0c)"
        stroke="var(--vl-stroke, rgba(255,255,255,0.12))"
        strokeWidth="1"
      />

      {/* Expressive eyes/mouth reacting to voiceState */}
      {isMuted ? (
        <g stroke="var(--status-failed, #ef4444)" strokeWidth="2.2" strokeLinecap="round">
          <line x1="45" y1="36" x2="53" y2="44" />
          <line x1="53" y1="36" x2="45" y2="44" />
          <line x1="67" y1="36" x2="75" y2="44" />
          <line x1="75" y1="36" x2="67" y2="44" />
        </g>
      ) : (
        <g>
          <rect x="45" y="33" width="8" height={isThinking ? 5 : 9} rx="2" fill="var(--accent, #5c8fff)" />
          <rect x="47" y="34.5" width="3" height="3" rx="1" fill="#ffffff" />
          <rect x="67" y="33" width="8" height={isThinking ? 5 : 9} rx="2" fill="var(--accent, #5c8fff)" />
          <rect x="69" y="34.5" width="3" height="3" rx="1" fill="#ffffff" />
        </g>
      )}

      {isSpeaking ? (
        <g className="theme-hero-figure__bars">
          <rect className="theme-hero-figure__bar" x="51" y="46" width="3" height="5" rx="1" fill="var(--accent, #5c8fff)" />
          <rect className="theme-hero-figure__bar" x="56" y="45" width="3" height="7" rx="1" fill="var(--text-primary, #f3f4f6)" />
          <rect className="theme-hero-figure__bar" x="61" y="45" width="3" height="7" rx="1" fill="var(--text-primary, #f3f4f6)" />
          <rect className="theme-hero-figure__bar" x="66" y="46" width="3" height="5" rx="1" fill="var(--accent, #5c8fff)" />
        </g>
      ) : (
        <rect
          x="52"
          y="47"
          width="16"
          height="2.8"
          rx="1.4"
          fill={isMuted ? 'var(--status-failed, #ef4444)' : 'var(--accent, #5c8fff)'}
          fillOpacity={isMuted ? 0.55 : 0.8}
        />
      )}

      {/* Torso & feet */}
      <rect
        x="40"
        y="63"
        width="40"
        height="16"
        rx="4"
        fill="var(--pane, #181825)"
        stroke="var(--text-secondary, #94a3b8)"
        strokeOpacity="0.55"
        strokeWidth="1.75"
      />
      <rect x="46" y="68" width="11" height="6" rx="1.5" fill="var(--accent, #5c8fff)" fillOpacity="0.88" />
      <rect x="61" y="69" width="13" height="4" rx="1.5" fill="var(--text-secondary, #94a3b8)" fillOpacity="0.5" />
      <rect x="43" y="79" width="10" height="6.5" rx="2" fill="var(--text-primary, #f3f4f6)" fillOpacity="0.82" />
      <rect x="67" y="79" width="10" height="6.5" rx="2" fill="var(--text-primary, #f3f4f6)" fillOpacity="0.82" />
    </svg>
  );
};

const EditorialBotanicalSvg: React.FC<FigureSvgProps> = ({ uid }) => (
  <svg
    className="theme-hero-figure__svg"
    viewBox="0 0 120 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <linearGradient id={`eb-leaf-${uid}`} x1="44" y1="44" x2="76" y2="70" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="var(--accent, #d97757)" stopOpacity="0.46" />
        <stop offset="100%" stopColor="var(--accent, #d97757)" stopOpacity="0.14" />
      </linearGradient>
    </defs>

    {/* Double architectural arch */}
    <path
      d="M32 86V45C32 29.536 44.536 17 60 17C75.464 17 88 29.536 88 45V86"
      stroke="var(--accent, #d97757)"
      strokeOpacity="0.46"
      strokeWidth="1.4"
    />
    <path
      d="M37 86V46C37 33.297 47.297 23 60 23C72.703 23 83 33.297 83 46V86"
      stroke="var(--text-secondary, #94a3b8)"
      strokeOpacity="0.28"
      strokeWidth="1"
    />

    {/* Solar disc */}
    <circle
      className="theme-hero-figure__pulse-core"
      cx="60"
      cy="38"
      r="11"
      fill="var(--accent, #d97757)"
      fillOpacity="0.24"
      stroke="var(--accent, #d97757)"
      strokeWidth="1.6"
    />
    <circle cx="60" cy="38" r="4" fill="var(--text-primary, #f5f2eb)" fillOpacity="0.85" />

    {/* Stem & veined botanical leaves */}
    <path
      d="M60 86V42"
      stroke="var(--text-primary, #f5f2eb)"
      strokeWidth="1.65"
      strokeLinecap="round"
    />
    <path
      d="M60 70C47 68 41 60 43 51C51 51 58 59 60 70Z"
      fill={`url(#eb-leaf-${uid})`}
      stroke="var(--accent, #d97757)"
      strokeWidth="1.45"
      strokeLinejoin="round"
    />
    <path
      d="M60 60C73 58 79 50 77 41C69 41 62 49 60 60Z"
      fill={`url(#eb-leaf-${uid})`}
      stroke="var(--accent, #d97757)"
      strokeWidth="1.45"
      strokeLinejoin="round"
    />
    <path d="M58 67L48 56M62 57L72 46" stroke="var(--text-primary, #f5f2eb)" strokeOpacity="0.35" strokeWidth="1" strokeLinecap="round" />

    {/* Editorial stars */}
    <path d="M22 29L24 34L29 36L24 38L22 43L20 38L15 36L20 34L22 29Z" fill="var(--accent, #d97757)" fillOpacity="0.78" />
    <path d="M98 25L99.5 29L103.5 30.5L99.5 32L98 36L96.5 32L92.5 30.5L96.5 29L98 25Z" fill="var(--accent, #d97757)" fillOpacity="0.78" />
  </svg>
);
