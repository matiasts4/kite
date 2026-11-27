import React from 'react';
import type { FigureMood, FigureReaction, FigureVoiceState } from './ThemeHeroFigure';

export interface FigureSvgProps {
  uid: string;
  voiceState?: FigureVoiceState;
  reaction?: FigureReaction;
  mood?: FigureMood;
}

export const PixelCompanionSvg: React.FC<FigureSvgProps> = ({
  uid,
  voiceState = 'idle',
  reaction = 'idle',
  mood = 'idle',
}) => {
  const isMuted = voiceState === 'muted' || voiceState === 'error';
  const isSpeaking = voiceState === 'speaking';
  const isThinking = voiceState === 'thinking' || voiceState === 'transcribing';
  const isExcited = reaction === 'excited';
  const isGreeting = reaction === 'greeting';
  const isCurious = !isExcited && !isGreeting && mood === 'curious';

  return (
    <svg
      className="theme-hero-figure__svg kite-px"
      viewBox="0 0 120 104"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={`px-body-${uid}`} x1="34" y1="22" x2="86" y2="82" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--composer, var(--pane, #1c1f2b))" stopOpacity="0.98" />
          <stop offset="100%" stopColor="var(--background, #090a0c)" stopOpacity="0.96" />
        </linearGradient>
        <linearGradient id={`px-visor-${uid}`} x1="38" y1="28" x2="82" y2="54" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--background, #07090d)" stopOpacity="0.96" />
          <stop offset="100%" stopColor="var(--pane, #101420)" stopOpacity="0.92" />
        </linearGradient>
        <linearGradient id={`px-sheen-${uid}`} x1="36" y1="24" x2="72" y2="38" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--text-primary, #ffffff)" stopOpacity="0.24" />
          <stop offset="100%" stopColor="var(--text-primary, #ffffff)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Reactive ground shadow */}
      <ellipse
        className="kite-px__shadow"
        cx="60"
        cy="93"
        rx="26"
        ry="4.2"
        fill="var(--accent, #5c8fff)"
        fillOpacity="0.22"
      />

      {/* Celebratory floating pixel sparkles */}
      <g className="kite-px__sparkles">
        <path
          className="kite-px__spark kite-px__spark--1"
          d="M18 22L20 26L24 28L20 30L18 34L16 30L12 28L16 26L18 22Z"
          fill="var(--accent, #5c8fff)"
        />
        <rect
          className="kite-px__spark kite-px__spark--2"
          x="97"
          y="16"
          width="5"
          height="5"
          rx="1.2"
          fill="var(--accent, #5c8fff)"
        />
        <rect
          className="kite-px__spark kite-px__spark--3"
          x="103"
          y="29"
          width="3.6"
          height="3.6"
          rx="1"
          fill="var(--text-primary, #f8fafc)"
        />
        <rect
          className="kite-px__spark kite-px__spark--4"
          x="14"
          y="40"
          width="3.6"
          height="3.6"
          rx="1"
          fill="var(--text-secondary, #94a3b8)"
        />
      </g>

      {/* Articulated character rig */}
      <g className="kite-px__rig">
        {/* Feet */}
        <rect
          className="kite-px__foot kite-px__foot--left"
          x="43"
          y="81"
          width="11"
          height="7"
          rx="2.5"
          fill="var(--text-primary, #f3f4f6)"
          fillOpacity="0.86"
        />
        <rect
          className="kite-px__foot kite-px__foot--right"
          x="66"
          y="81"
          width="11"
          height="7"
          rx="2.5"
          fill="var(--text-primary, #f3f4f6)"
          fillOpacity="0.86"
        />

        {/* Left arm */}
        <g className="kite-px__arm-left">
          <rect
            x="29"
            y="64"
            width="9"
            height="14"
            rx="3.5"
            fill={`url(#px-body-${uid})`}
            stroke="var(--accent, #5c8fff)"
            strokeOpacity="0.72"
            strokeWidth="1.6"
          />
          <circle cx="33.5" cy="76" r="2.2" fill="var(--accent, #5c8fff)" fillOpacity="0.7" />
        </g>

        {/* Right articulated waving arm */}
        <g className="kite-px__arm-right">
          <rect
            x="82"
            y="64"
            width="9"
            height="14"
            rx="3.5"
            fill={`url(#px-body-${uid})`}
            stroke="var(--accent, #5c8fff)"
            strokeOpacity="0.88"
            strokeWidth="1.6"
          />
          <circle cx="86.5" cy="76" r="2.4" fill="var(--accent, #5c8fff)" />
        </g>

        {/* Torso */}
        <rect
          x="40"
          y="64"
          width="40"
          height="17"
          rx="5"
          fill={`url(#px-body-${uid})`}
          stroke="var(--text-secondary, #94a3b8)"
          strokeOpacity="0.52"
          strokeWidth="1.65"
        />
        <rect
          className="kite-px__chest-core"
          x="46"
          y="69"
          width="12"
          height="7"
          rx="2"
          fill="var(--accent, #5c8fff)"
          fillOpacity="0.88"
        />
        <rect x="62" y="70" width="4" height="5" rx="1.2" fill="var(--text-primary, #f8fafc)" fillOpacity="0.7" />
        <rect x="68" y="70" width="6" height="5" rx="1.2" fill="var(--text-secondary, #94a3b8)" fillOpacity="0.45" />

        {/* Head + spring antenna */}
        <g className="kite-px__head">
          <g className="kite-px__antenna">
            <rect x="57.75" y="13" width="4.5" height="9" rx="1.5" fill="var(--text-secondary, #94a3b8)" />
            <circle
              className="theme-hero-figure__pulse-core kite-px__beacon"
              cx="60"
              cy="10"
              r="5"
              fill={isMuted ? 'var(--status-failed, #ef4444)' : 'var(--accent, #5c8fff)'}
            />
            <circle cx="58.5" cy="8.5" r="1.5" fill="var(--text-primary, #ffffff)" fillOpacity="0.9" />
          </g>

          {/* Ear couplers */}
          <rect x="25" y="34" width="6" height="15" rx="2.5" fill="var(--accent, #5c8fff)" fillOpacity="0.72" />
          <rect x="89" y="34" width="6" height="15" rx="2.5" fill="var(--accent, #5c8fff)" fillOpacity="0.72" />

          {/* Head shell */}
          <rect
            x="31"
            y="21"
            width="58"
            height="43"
            rx="9"
            fill={`url(#px-body-${uid})`}
            stroke={isMuted ? 'var(--status-failed, #ef4444)' : 'var(--accent, #5c8fff)'}
            strokeWidth="2.1"
          />
          <rect x="33" y="23" width="54" height="12" rx="6" fill={`url(#px-sheen-${uid})`} />

          {/* Visor screen */}
          <rect
            x="38"
            y="28"
            width="44"
            height="27"
            rx="5.5"
            fill={`url(#px-visor-${uid})`}
            stroke="var(--vl-stroke, rgba(255,255,255,0.14))"
            strokeWidth="1.1"
          />

          {/* Gaze-tracking expressive eyes */}
          <g className="kite-px__eyes">
            {isMuted ? (
              <g stroke="var(--status-failed, #ef4444)" strokeWidth="2.2" strokeLinecap="round">
                <line x1="45" y1="36" x2="53" y2="44" />
                <line x1="53" y1="36" x2="45" y2="44" />
                <line x1="67" y1="36" x2="75" y2="44" />
                <line x1="75" y1="36" x2="67" y2="44" />
              </g>
            ) : isExcited ? (
              <g stroke="var(--accent, #5c8fff)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M44.5 41.5L49 36.5L53.5 41.5" />
                <path d="M66.5 41.5L71 36.5L75.5 41.5" />
              </g>
            ) : (
              <g className="kite-px__eye-pair">
                <rect
                  x="45"
                  y={isCurious ? 35 : 33.5}
                  width="8.5"
                  height={isThinking ? 5.5 : 9.5}
                  rx="2.6"
                  fill="var(--accent, #5c8fff)"
                />
                <rect
                  x="47.2"
                  y={isCurious ? 37.5 : 35.2}
                  width="3.2"
                  height="3.2"
                  rx="1"
                  fill="var(--text-primary, #ffffff)"
                />
                <rect
                  x="66.5"
                  y={isCurious ? 35 : 33.5}
                  width="8.5"
                  height={isThinking ? 5.5 : 9.5}
                  rx="2.6"
                  fill="var(--accent, #5c8fff)"
                />
                <rect
                  x="68.7"
                  y={isCurious ? 37.5 : 35.2}
                  width="3.2"
                  height="3.2"
                  rx="1"
                  fill="var(--text-primary, #ffffff)"
                />
              </g>
            )}

            {/* Mouth */}
            {isSpeaking ? (
              <g className="theme-hero-figure__bars">
                <rect className="theme-hero-figure__bar" x="51" y="47" width="3" height="5" rx="1.2" fill="var(--accent, #5c8fff)" />
                <rect className="theme-hero-figure__bar" x="56" y="46" width="3" height="7" rx="1.2" fill="var(--text-primary, #f3f4f6)" />
                <rect className="theme-hero-figure__bar" x="61" y="46" width="3" height="7" rx="1.2" fill="var(--text-primary, #f3f4f6)" />
                <rect className="theme-hero-figure__bar" x="66" y="47" width="3" height="5" rx="1.2" fill="var(--accent, #5c8fff)" />
              </g>
            ) : isExcited || isGreeting ? (
              <path
                d="M53 47.2C55.5 51.2 64.5 51.2 67 47.2"
                stroke="var(--text-primary, #f8fafc)"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            ) : isCurious ? (
              <circle cx="60" cy="49" r="2.2" fill="var(--accent, #5c8fff)" fillOpacity="0.92" />
            ) : (
              <path
                d="M54 48.2C56.5 50.2 63.5 50.2 66 48.2"
                stroke={isMuted ? 'var(--status-failed, #ef4444)' : 'var(--accent, #5c8fff)'}
                strokeOpacity={isMuted ? 0.65 : 0.88}
                strokeWidth="2"
                strokeLinecap="round"
              />
            )}
          </g>
        </g>
      </g>
    </svg>
  );
};

export const KiteCrestSvg: React.FC<FigureSvgProps> = ({ uid }) => (
  <svg
    className="theme-hero-figure__svg kite-kc"
    viewBox="0 0 120 104"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <linearGradient id={`kc-left-${uid}`} x1="28" y1="14" x2="60" y2="62" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="var(--accent, #5c8fff)" stopOpacity="0.72" />
        <stop offset="100%" stopColor="var(--accent, #5c8fff)" stopOpacity="0.18" />
      </linearGradient>
      <linearGradient id={`kc-right-${uid}`} x1="60" y1="14" x2="92" y2="62" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="var(--text-primary, #f3f4f6)" stopOpacity="0.42" />
        <stop offset="100%" stopColor="var(--accent, #5c8fff)" stopOpacity="0.1" />
      </linearGradient>
      <linearGradient id={`kc-lower-${uid}`} x1="60" y1="44" x2="92" y2="82" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="var(--accent, #5c8fff)" stopOpacity="0.4" />
        <stop offset="100%" stopColor="var(--pane, #0d0f12)" stopOpacity="0.9" />
      </linearGradient>
    </defs>

    <g className="theme-hero-figure__orbit kite-kc__reticle">
      <circle
        cx="60"
        cy="48"
        r="41"
        stroke="var(--accent, #5c8fff)"
        strokeOpacity="0.26"
        strokeWidth="1.1"
        strokeDasharray="4 6"
      />
      <circle cx="101" cy="48" r="2.2" fill="var(--accent, #5c8fff)" fillOpacity="0.7" />
      <circle cx="19" cy="48" r="1.8" fill="var(--text-primary, #f8fafc)" fillOpacity="0.55" />
    </g>

    <path
      d="M60 4V9M60 87V92M16 48H21M99 48H104"
      stroke="var(--text-secondary, #94a3b8)"
      strokeOpacity="0.38"
      strokeWidth="1.2"
      strokeLinecap="round"
    />

    <g className="kite-kc__craft">
      <path
        d="M60 12L28 45L60 60V12Z"
        fill={`url(#kc-left-${uid})`}
        stroke="var(--accent, #5c8fff)"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M60 12L92 45L60 60V12Z"
        fill={`url(#kc-right-${uid})`}
        stroke="var(--accent, #5c8fff)"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M28 45L60 80V60L28 45Z"
        fill="var(--pane, #0d0f12)"
        fillOpacity="0.88"
        stroke="var(--accent, #5c8fff)"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M92 45L60 80V60L92 45Z"
        fill={`url(#kc-lower-${uid})`}
        stroke="var(--accent, #5c8fff)"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />

      <path
        d="M60 20L40 45L60 54L80 45L60 20Z"
        stroke="var(--text-primary, #f3f4f6)"
        strokeOpacity="0.36"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />

      <g className="kite-kc__tail">
        <path
          d="M60 80C64 89 74 92 85 87C91 84.5 96 86 100 90"
          stroke="var(--accent, #5c8fff)"
          strokeWidth="1.65"
          strokeLinecap="round"
        />
        <path d="M74 87L76.8 89.8L74 92.6L71.2 89.8L74 87Z" fill="var(--text-primary, #f8fafc)" />
        <path d="M88 84L90.8 86.8L88 89.6L85.2 86.8L88 84Z" fill="var(--accent, #5c8fff)" />
      </g>

      <circle
        className="theme-hero-figure__pulse-core kite-kc__beacon"
        cx="60"
        cy="45"
        r="8.5"
        fill="var(--accent, #5c8fff)"
        fillOpacity="0.28"
      />
      <circle cx="60" cy="45" r="3.6" fill="var(--text-primary, #f8fafc)" />
    </g>
  </svg>
);

export const OrbitalConstellationSvg: React.FC<FigureSvgProps> = ({ uid }) => (
  <svg
    className="theme-hero-figure__svg kite-oc"
    viewBox="0 0 120 104"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <linearGradient id={`oc-ring-${uid}`} x1="20" y1="30" x2="100" y2="70" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="var(--accent, #38bdf8)" stopOpacity="0.92" />
        <stop offset="100%" stopColor="var(--accent, #38bdf8)" stopOpacity="0.14" />
      </linearGradient>
    </defs>

    <g className="theme-hero-figure__orbit kite-oc__outer">
      <circle
        cx="60"
        cy="52"
        r="40"
        stroke="var(--accent, #38bdf8)"
        strokeOpacity="0.26"
        strokeWidth="1.2"
        strokeDasharray="3 6"
      />
      <circle cx="60" cy="12" r="2.8" fill="var(--accent, #38bdf8)" />
    </g>

    <g className="kite-oc__tilt-a">
      <ellipse
        cx="60"
        cy="52"
        rx="41"
        ry="16"
        transform="rotate(-24 60 52)"
        stroke={`url(#oc-ring-${uid})`}
        strokeWidth="1.65"
      />
      <circle cx="96" cy="36" r="2.6" fill="var(--text-primary, #f8fafc)" />
    </g>

    <g className="theme-hero-figure__orbit-reverse kite-oc__tilt-b">
      <ellipse
        cx="60"
        cy="52"
        rx="38"
        ry="15.5"
        transform="rotate(30 60 52)"
        stroke="var(--text-secondary, #94a3b8)"
        strokeOpacity="0.48"
        strokeWidth="1.35"
      />
      <circle cx="27" cy="34" r="2.2" fill="var(--accent, #38bdf8)" fillOpacity="0.8" />
    </g>

    <path
      className="kite-oc__link"
      d="M30 60L48 35L69 64L90 40"
      stroke="var(--accent, #38bdf8)"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M48 35L90 40"
      stroke="var(--accent, #38bdf8)"
      strokeOpacity="0.32"
      strokeWidth="1.1"
      strokeDasharray="2 3"
    />

    <circle
      className="theme-hero-figure__pulse-core kite-oc__core"
      cx="60"
      cy="52"
      r="10"
      fill="var(--accent, #38bdf8)"
      fillOpacity="0.24"
    />
    <circle cx="60" cy="52" r="4.2" fill="var(--text-primary, #f8fafc)" />

    <circle className="kite-oc__star kite-oc__star--1" cx="30" cy="60" r="3.4" fill="var(--pane, #0d1424)" stroke="var(--accent, #38bdf8)" strokeWidth="1.7" />
    <circle className="kite-oc__star kite-oc__star--2" cx="48" cy="35" r="4" fill="var(--accent, #38bdf8)" />
    <circle className="kite-oc__star kite-oc__star--3" cx="69" cy="64" r="4" fill="var(--accent, #38bdf8)" />
    <circle className="kite-oc__star kite-oc__star--4" cx="90" cy="40" r="3.4" fill="var(--pane, #0d1424)" stroke="var(--accent, #38bdf8)" strokeWidth="1.7" />
  </svg>
);

export const IsometricConstructSvg: React.FC<FigureSvgProps> = ({ uid }) => (
  <svg
    className="theme-hero-figure__svg kite-iso"
    viewBox="0 0 120 104"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <linearGradient id={`ic-top-${uid}`} x1="34" y1="20" x2="86" y2="50" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="var(--accent, #5c8fff)" stopOpacity="0.58" />
        <stop offset="100%" stopColor="var(--accent, #5c8fff)" stopOpacity="0.18" />
      </linearGradient>
      <linearGradient id={`ic-right-${uid}`} x1="60" y1="50" x2="86" y2="80" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="var(--accent, #5c8fff)" stopOpacity="0.34" />
        <stop offset="100%" stopColor="var(--pane, #181825)" stopOpacity="0.9" />
      </linearGradient>
    </defs>

    {/* Architectural base platform */}
    <path
      className="kite-iso__base"
      d="M60 93L18 71L60 49L102 71L60 93Z"
      stroke="var(--accent, #5c8fff)"
      strokeOpacity="0.34"
      strokeWidth="1.35"
      fill="var(--accent, #5c8fff)"
      fillOpacity="0.07"
    />
    <path
      d="M60 12L94 30V70L60 88L26 70V30L60 12Z"
      stroke="var(--text-secondary, #94a3b8)"
      strokeOpacity="0.38"
      strokeWidth="1.2"
      strokeDasharray="4 3"
    />

    {/* Lower monolith pedestal */}
    <g className="kite-iso__lower">
      <path
        d="M34 49L60 63V81L34 67V49Z"
        fill="var(--pane, #181825)"
        fillOpacity="0.92"
        stroke="var(--accent, #5c8fff)"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
      <path
        d="M86 49L60 63V81L86 67V49Z"
        fill={`url(#ic-right-${uid})`}
        stroke="var(--accent, #5c8fff)"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
    </g>

    {/* Levitating inner crystal core */}
    <g className="kite-iso__core">
      <path
        className="theme-hero-figure__pulse-core"
        d="M60 39L72 51L60 63L48 51L60 39Z"
        fill="var(--accent, #5c8fff)"
        fillOpacity="0.36"
        stroke="var(--text-primary, #f8fafc)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="60" cy="51" r="3.4" fill="var(--text-primary, #f8fafc)" />
    </g>

    {/* Floating split upper prism cap */}
    <g className="kite-iso__cap">
      <path
        d="M60 18L86 32L60 46L34 32L60 18Z"
        fill={`url(#ic-top-${uid})`}
        stroke="var(--accent, #5c8fff)"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M34 32L60 46V53L34 39V32Z"
        fill="var(--pane, #181825)"
        fillOpacity="0.88"
        stroke="var(--accent, #5c8fff)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M86 32L60 46V53L86 39V32Z"
        fill={`url(#ic-right-${uid})`}
        stroke="var(--accent, #5c8fff)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="60" cy="18" r="2.6" fill="var(--text-primary, #f8fafc)" />
      <circle cx="34" cy="32" r="2.2" fill="var(--accent, #5c8fff)" />
      <circle cx="86" cy="32" r="2.2" fill="var(--accent, #5c8fff)" />
    </g>
  </svg>
);

export const EditorialBotanicalSvg: React.FC<FigureSvgProps> = ({ uid }) => (
  <svg
    className="theme-hero-figure__svg kite-eb"
    viewBox="0 0 120 104"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <linearGradient id={`eb-leaf-${uid}`} x1="42" y1="42" x2="78" y2="74" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="var(--accent, #d97757)" stopOpacity="0.54" />
        <stop offset="100%" stopColor="var(--accent, #d97757)" stopOpacity="0.16" />
      </linearGradient>
    </defs>

    {/* Double architectural arch */}
    <path
      d="M30 89V46C30 29.431 43.431 16 60 16C76.569 16 90 29.431 90 46V89"
      stroke="var(--accent, #d97757)"
      strokeOpacity="0.48"
      strokeWidth="1.45"
    />
    <path
      d="M36 89V47C36 33.745 46.745 23 60 23C73.255 23 84 33.745 84 47V89"
      stroke="var(--text-secondary, #94a3b8)"
      strokeOpacity="0.3"
      strokeWidth="1"
    />

    {/* Rotating solar halo + sun disc */}
    <g className="kite-eb__sun">
      <circle
        cx="60"
        cy="39"
        r="16"
        stroke="var(--accent, #d97757)"
        strokeOpacity="0.3"
        strokeWidth="1.1"
        strokeDasharray="2 5"
      />
      <circle
        className="theme-hero-figure__pulse-core"
        cx="60"
        cy="39"
        r="10.5"
        fill="var(--accent, #d97757)"
        fillOpacity="0.28"
        stroke="var(--accent, #d97757)"
        strokeWidth="1.6"
      />
      <circle cx="60" cy="39" r="4" fill="var(--text-primary, #f5f2eb)" fillOpacity="0.92" />
    </g>

    {/* Stem & articulated swaying leaves */}
    <path
      className="kite-eb__stem"
      d="M60 89V43"
      stroke="var(--text-primary, #f5f2eb)"
      strokeWidth="1.75"
      strokeLinecap="round"
    />
    <g className="kite-eb__leaf-left">
      <path
        d="M60 73C45 71 39 62 41 52C50 52 58 61 60 73Z"
        fill={`url(#eb-leaf-${uid})`}
        stroke="var(--accent, #d97757)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M58 69L47 58" stroke="var(--text-primary, #f5f2eb)" strokeOpacity="0.38" strokeWidth="1" strokeLinecap="round" />
    </g>
    <g className="kite-eb__leaf-right">
      <path
        d="M60 63C75 61 81 52 79 42C70 42 62 51 60 63Z"
        fill={`url(#eb-leaf-${uid})`}
        stroke="var(--accent, #d97757)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M62 59L73 48" stroke="var(--text-primary, #f5f2eb)" strokeOpacity="0.38" strokeWidth="1" strokeLinecap="round" />
    </g>

    {/* Editorial twinkling stars */}
    <path
      className="kite-eb__star kite-eb__star--1"
      d="M21 29L23 34L28 36L23 38L21 43L19 38L14 36L19 34L21 29Z"
      fill="var(--accent, #d97757)"
    />
    <path
      className="kite-eb__star kite-eb__star--2"
      d="M99 25L100.6 29L104.6 30.6L100.6 32.2L99 36.2L97.4 32.2L93.4 30.6L97.4 29L99 25Z"
      fill="var(--accent, #d97757)"
    />
  </svg>
);

export const KineticRingSvg: React.FC<FigureSvgProps> = ({
  uid,
  voiceState = 'idle',
  reaction = 'idle',
  mood = 'idle',
}) => {
  const showBars =
    voiceState !== 'idle' && voiceState !== 'muted'
      ? true
      : reaction === 'greeting' || reaction === 'excited' || mood === 'curious';

  return (
    <svg
      className="theme-hero-figure__svg kite-kr"
      viewBox="0 0 120 104"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={`kr-arc-${uid}`} x1="22" y1="16" x2="98" y2="86" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--accent, #5c8fff)" stopOpacity="0.96" />
          <stop offset="100%" stopColor="var(--accent, #5c8fff)" stopOpacity="0.16" />
        </linearGradient>
      </defs>

      <g className="theme-hero-figure__orbit kite-kr__outer">
        <circle
          cx="60"
          cy="52"
          r="40"
          stroke="var(--accent, #5c8fff)"
          strokeOpacity="0.24"
          strokeWidth="1.25"
          strokeDasharray="16 8 4 8"
        />
        <path
          d="M60 12A40 40 0 0 1 98 39"
          stroke={`url(#kr-arc-${uid})`}
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <path
          d="M60 92A40 40 0 0 1 22 65"
          stroke="var(--text-secondary, #94a3b8)"
          strokeOpacity="0.54"
          strokeWidth="1.65"
          strokeLinecap="round"
        />
      </g>

      <g className="theme-hero-figure__orbit-reverse kite-kr__inner">
        <circle
          cx="60"
          cy="52"
          r="29"
          stroke="var(--accent, #5c8fff)"
          strokeOpacity="0.48"
          strokeWidth="1.4"
          strokeDasharray="44 18 14 16"
        />
        <circle cx="89" cy="52" r="2.8" fill="var(--accent, #5c8fff)" />
        <circle cx="31" cy="52" r="2.1" fill="var(--text-primary, #f3f4f6)" fillOpacity="0.78" />
      </g>

      <circle
        cx="60"
        cy="52"
        r="20"
        fill="var(--pane, #0d0f12)"
        fillOpacity="0.9"
        stroke="var(--accent, #5c8fff)"
        strokeOpacity="0.42"
        strokeWidth="1.4"
      />

      {voiceState === 'muted' ? (
        <g stroke="var(--status-failed, #ef4444)" strokeWidth="2.1" strokeLinecap="round">
          <line x1="53" y1="45" x2="67" y2="59" />
          <line x1="67" y1="45" x2="53" y2="59" />
        </g>
      ) : showBars ? (
        <g className="theme-hero-figure__bars kite-kr__bars">
          <rect className="theme-hero-figure__bar" x="48.5" y="47" width="2.8" height="10" rx="1.4" fill="var(--accent, #5c8fff)" />
          <rect className="theme-hero-figure__bar" x="53.6" y="43" width="2.8" height="18" rx="1.4" fill="var(--accent, #5c8fff)" />
          <rect className="theme-hero-figure__bar" x="58.6" y="40" width="2.8" height="24" rx="1.4" fill="var(--text-primary, #f8fafc)" />
          <rect className="theme-hero-figure__bar" x="63.6" y="43" width="2.8" height="18" rx="1.4" fill="var(--accent, #5c8fff)" />
          <rect className="theme-hero-figure__bar" x="68.7" y="47" width="2.8" height="10" rx="1.4" fill="var(--accent, #5c8fff)" />
        </g>
      ) : (
        <g className="kite-kr__diamond">
          <path
            d="M60 40L71 52L60 64L49 52L60 40Z"
            fill="var(--accent, #5c8fff)"
            fillOpacity="0.26"
            stroke="var(--accent, #5c8fff)"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <circle cx="60" cy="52" r="3.2" fill="var(--text-primary, #f8fafc)" />
        </g>
      )}
    </svg>
  );
};
