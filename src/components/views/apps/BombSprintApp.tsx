import React, { useState, useEffect, useRef, useId, useMemo } from 'react';
import {
  IconVolume,
  IconVolumeX,
  IconPlay,
  IconPause,
  IconRotateCcw,
} from './appIcons';

type BombPhase = 'idle' | 'running' | 'danger' | 'exploded';

const PRESET_MINUTES = [5, 10, 15, 25];

// --- 7-segment LED geometry ---
const SEG_G = 7;
const SEG_AE = 32;
const SEG_K = 58;
const SEG_R = SEG_G / 2; // 3.5

function horizSeg(x1: number, x2: number, y: number): string {
  return `M${x1} ${y}L${x1 + SEG_R} ${y - SEG_R}L${x2 - SEG_R} ${y - SEG_R}L${x2} ${y}L${x2 - SEG_R} ${y + SEG_R}L${x1 + SEG_R} ${y + SEG_R}Z`;
}

function vertSeg(x: number, y1: number, y2: number): string {
  return `M${x} ${y1}L${x + SEG_R} ${y1 + SEG_R}L${x + SEG_R} ${y2 - SEG_R}L${x} ${y2}L${x - SEG_R} ${y2 - SEG_R}L${x - SEG_R} ${y1 + SEG_R}Z`;
}

const SEGMENT_PATHS: Record<string, string> = {
  A: horizSeg(2.5, 29.5, 4.5),
  B: vertSeg(SEG_AE - SEG_R - 1, 3, SEG_K / 2 - 1),
  C: vertSeg(SEG_AE - SEG_R - 1, 30, 55),
  D: horizSeg(2.5, 29.5, SEG_K - SEG_R - 1),
  E: vertSeg(4.5, 30, 55),
  F: vertSeg(4.5, 3, SEG_K / 2 - 1),
  G: horizSeg(4, 28, SEG_K / 2),
};

const ALL_SEGMENTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

const DIGIT_MAP: Record<string, string[]> = {
  '0': ['A', 'B', 'C', 'D', 'E', 'F'],
  '1': ['B', 'C'],
  '2': ['A', 'B', 'G', 'E', 'D'],
  '3': ['A', 'B', 'G', 'C', 'D'],
  '4': ['F', 'G', 'B', 'C'],
  '5': ['A', 'F', 'G', 'C', 'D'],
  '6': ['A', 'F', 'G', 'E', 'D', 'C'],
  '7': ['A', 'B', 'C'],
  '8': ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
  '9': ['A', 'B', 'C', 'D', 'F', 'G'],
  '-': ['G'],
};

const COLON_DOTS = [
  { x: 4.5, y: SEG_K * 0.3, size: 5.5 },
  { x: 4.5, y: SEG_K * 0.68, size: 5.5 },
];

export interface BombSprintAppProps {
  embedded?: boolean;
}

export const BombSprintApp: React.FC<BombSprintAppProps> = ({ embedded: _embedded = false }) => {
  const [label, setLabel] = useState('Shipping Core Features');
  const [minutes, setMinutes] = useState(10);
  const [secondsRemaining, setSecondsRemaining] = useState(10 * 60);
  const [phase, setPhase] = useState<BombPhase>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const bombId = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  const playSynthesizedSound = (type: 'beepLow' | 'beepHigh' | 'ignite' | 'explode') => {
    if (isMuted) return;
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume();

      const now = ctx.currentTime;

      if (type === 'beepLow') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, now);
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(now + 0.08);
      } else if (type === 'beepHigh') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(880, now);
        gain.gain.setValueAtTime(0.09, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(now + 0.09);
      } else if (type === 'ignite') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.exponentialRampToValueAtTime(660, now + 0.15);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(now + 0.2);
      } else if (type === 'explode') {
        // Deep sub-bass boom
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(140, now);
        osc.frequency.exponentialRampToValueAtTime(30, now + 0.8);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(now + 1.2);
      }
    } catch {
      // AudioContext unavailable
    }
  };

  useEffect(() => {
    return () => {
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
    };
  }, []);

  // Main countdown timer
  useEffect(() => {
    let interval: number | undefined;
    if (phase === 'running' || phase === 'danger') {
      interval = window.setInterval(() => {
        setSecondsRemaining((prev) => {
          if (prev <= 1) {
            setPhase('exploded');
            playSynthesizedSound('explode');
            return 0;
          }
          if (prev <= 10) {
            setPhase('danger');
            playSynthesizedSound('beepHigh');
          } else if (prev % 60 === 0) {
            playSynthesizedSound('beepLow');
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [phase, isMuted]);

  const handleStartSprint = () => {
    setSecondsRemaining(minutes * 60);
    setPhase('running');
    playSynthesizedSound('ignite');
  };

  const handleReset = () => {
    setPhase('idle');
    setSecondsRemaining(minutes * 60);
    playSynthesizedSound('beepLow');
  };

  const handleDetonateNow = () => {
    setSecondsRemaining(0);
    setPhase('exploded');
    playSynthesizedSound('explode');
  };

  const timeString = useMemo(() => {
    if (phase === 'exploded') return '00:00';
    const m = Math.floor(secondsRemaining / 60);
    const s = secondsRemaining % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }, [secondsRemaining, phase]);

  // Compute 7-Segment SVG display layout
  const ledRender = useMemo(() => {
    const items: React.ReactNode[] = [];
    let currentX = 0;

    for (let i = 0; i < timeString.length; i++) {
      const char = timeString[i];
      if (char === ':') {
        items.push(
          <g key={`colon-${i}`} transform={`translate(${currentX}, 0)`}>
            {COLON_DOTS.map((dot, dIdx) => (
              <rect
                key={dIdx}
                x={dot.x}
                y={dot.y}
                width={dot.size}
                height={dot.size}
                rx="1.5"
                fill={
                  phase === 'exploded'
                    ? '#ef4444'
                    : phase === 'danger'
                    ? '#ff2a1c'
                    : '#ff9440'
                }
                filter={`url(#ledGlow-${bombId})`}
              />
            ))}
          </g>
        );
        currentX += 16;
      } else {
        const litSegments = DIGIT_MAP[char] || [];
        items.push(
          <g key={`digit-${i}`} transform={`translate(${currentX}, 0)`}>
            {/* Ghost (unlit) segments */}
            {ALL_SEGMENTS.map((segKey) => (
              <path
                key={`ghost-${segKey}`}
                d={SEGMENT_PATHS[segKey]}
                fill="rgba(255, 60, 40, 0.08)"
              />
            ))}
            {/* Lit segments */}
            {litSegments.map((segKey) => (
              <path
                key={`lit-${segKey}`}
                d={SEGMENT_PATHS[segKey]}
                fill={
                  phase === 'exploded'
                    ? '#ef4444'
                    : phase === 'danger'
                    ? '#ff2a1c'
                    : '#ff9440'
                }
                filter={`url(#ledGlow-${bombId})`}
              />
            ))}
          </g>
        );
        currentX += 36;
      }
    }

    const totalWidth = currentX - 4;
    const scale = 0.88;
    const offsetX = 260 - (totalWidth * scale) / 2;
    const offsetY = 352 - (SEG_K * scale) / 2 + 1;

    return {
      transform: `translate(${offsetX.toFixed(2)}, ${offsetY.toFixed(2)}) scale(${scale}) skewX(-3)`,
      children: items,
    };
  }, [timeString, phase, bombId]);

  const mins = Math.floor(secondsRemaining / 60);
  const secs = secondsRemaining % 60;
  const padZero = (n: number) => n.toString().padStart(2, '0');

  return (
    <div className="bomb-sprint" style={{ width: '100%', height: '100%' }}>
      <div
        className="bomb-sprint__stage"
        data-phase={phase}
        data-blast={phase === 'exploded' ? '' : undefined}
      >
        <div className="bomb-sprint__header">
          <span className="bomb-sprint__dot" />
          <span className="bomb-sprint__label">{label.trim() || 'Bomb Sprint'}</span>
          <span className="bomb-sprint__status">{phase.toUpperCase()}</span>
        </div>

        <div className="bomb-sprint__scene">
          <svg
            viewBox="0 0 520 560"
            className="bomb-sprint__svg"
            style={{ width: '100%', height: '100%' }}
          >
            <defs>
              <filter id={`ledGlow-${bombId}`} x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="2.2" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>

              <radialGradient id={`casing-${bombId}`} cx="38%" cy="36%" r="62%">
                <stop offset="0%" stopColor="#3c4046" />
                <stop offset="35%" stopColor="#22252a" />
                <stop offset="70%" stopColor="#14171a" />
                <stop offset="100%" stopColor="#08090a" />
              </radialGradient>

              <linearGradient id={`steel-${bombId}`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#1e2024" />
                <stop offset="25%" stopColor="#484f58" />
                <stop offset="50%" stopColor="#6e727a" />
                <stop offset="75%" stopColor="#30363d" />
                <stop offset="100%" stopColor="#121316" />
              </linearGradient>

              <filter id={`pocketShadow-${bombId}`} x="-15%" y="-15%" width="130%" height="130%">
                <feGaussianBlur stdDeviation="3" />
              </filter>
            </defs>

            <ellipse cx="260" cy="514" rx="142" ry="16" fill="#000000" opacity="0.45" />
            <ellipse cx="260" cy="512" rx="84" ry="8" fill="#000000" opacity="0.65" />

            <g fill="none">
              <path
                d="M 260 164 C 250 120, 282 100, 324 86 C 368 71, 412 60, 442 82"
                stroke="#4a3d2a"
                strokeLinecap="round"
                strokeWidth="8.5"
              />
              <path
                d="M 260 164 C 250 120, 282 100, 324 86 C 368 71, 412 60, 442 82"
                stroke="#8b7652"
                strokeLinecap="round"
                strokeWidth="6"
              />
              <path
                d="M 260 164 C 250 120, 282 100, 324 86 C 368 71, 412 60, 442 82"
                stroke="#c4b089"
                strokeLinecap="round"
                strokeWidth="2"
                opacity="0.6"
                transform="translate(-0.8, -1.2)"
              />
            </g>

            {phase !== 'exploded' && phase !== 'idle' && (
              <g transform="translate(442, 82)">
                <circle r="14" fill="#ff7a00" opacity="0.3" />
                <circle r="9" fill="#ff7a00" opacity="0.75" />
                <circle r="5" fill="#ffd24a" />
                <circle r="2.5" fill="#ffffff" />
              </g>
            )}

            <circle
              cx="260"
              cy="352"
              r="156"
              fill={`url(#casing-${bombId})`}
              stroke={phase === 'danger' ? 'var(--status-failed)' : 'var(--block-stroke)'}
              strokeWidth={phase === 'danger' ? '3' : '1.5'}
            />

            <ellipse
              cx="210"
              cy="280"
              rx="48"
              ry="24"
              fill="#ffffff"
              opacity="0.12"
              transform="rotate(-28, 210, 280)"
            />
            <ellipse
              cx="200"
              cy="270"
              rx="20"
              ry="10"
              fill="#ffffff"
              opacity="0.22"
              transform="rotate(-28, 200, 270)"
            />

            <g stroke="#1a1c20" strokeWidth="1.2">
              <ellipse cx="260" cy="198" rx="46" ry="13" fill={`url(#steel-${bombId})`} />
              <rect x="236" y="164" width="48" height="34" fill={`url(#steel-${bombId})`} stroke="none" />
              <rect x="231" y="160" width="58" height="12" rx="4" fill={`url(#steel-${bombId})`} />
              <ellipse cx="260" cy="160" rx="28" ry="6" fill="#3a3d42" />
              <ellipse cx="260" cy="160" rx="10" ry="3" fill="#0d0e10" stroke="none" />
            </g>

            <rect
              x="169"
              y="304"
              width="182"
              height="94"
              rx="16"
              fill="#000000"
              opacity="0.6"
              filter={`url(#pocketShadow-${bombId})`}
            />

            <rect
              x="173"
              y="306"
              width="174"
              height="86"
              rx="13"
              fill="#0f1012"
              stroke="#262a30"
              strokeWidth="1.5"
            />

            <rect
              x="181"
              y="314"
              width="158"
              height="70"
              rx="8"
              fill="#0b0405"
              stroke="#000000"
              strokeWidth="2"
            />

            <path
              d="M 181 314 H 310 L 181 370 Z"
              fill="#ffffff"
              opacity="0.04"
              pointerEvents="none"
            />

            <g transform={ledRender.transform}>{ledRender.children}</g>
          </svg>
        </div>

        {phase === 'exploded' && (
          <div className="bomb-sprint__boom">
            <span className="bomb-sprint__boom-word">BOOM!</span>
            <span className="bomb-sprint__boom-line">Time is up!</span>
          </div>
        )}
      </div>

      <div className="bomb-sprint__controls">
        <div className="bomb-sprint__row">
          <input
            type="text"
            value={label}
            disabled={phase !== 'idle'}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="What are you shipping this sprint?"
            className="ui-field bomb-sprint__label-field"
          />
          <div className="bomb-sprint__duration">
            <input
              type="text"
              value={padZero(mins)}
              disabled={phase !== 'idle'}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!Number.isNaN(val) && val >= 0) {
                  setMinutes(val);
                  setSecondsRemaining(val * 60 + secs);
                }
              }}
              className="bomb-sprint__time bomb-sprint__time--minutes"
            />
            <span className="bomb-sprint__colon">:</span>
            <input
              type="text"
              value={padZero(secs)}
              disabled={phase !== 'idle'}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!Number.isNaN(val) && val >= 0 && val < 60) {
                  setSecondsRemaining(mins * 60 + val);
                }
              }}
              className="bomb-sprint__time"
            />
          </div>
        </div>

        {phase === 'idle' && (
          <div className="ui-segmented bomb-sprint__presets" style={{ width: '100%' }}>
            {PRESET_MINUTES.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMinutes(m);
                  setSecondsRemaining(m * 60);
                }}
                className={`ui-segmented__item${minutes === m ? ' ui-segmented__item--selected' : ''}`}
                aria-pressed={minutes === m}
              >
                {m}m
              </button>
            ))}
          </div>
        )}

        <div className="bomb-sprint__row">
          {phase === 'idle' ? (
            <button
              type="button"
              onClick={handleStartSprint}
              className="primary-button bomb-sprint__primary"
            >
              <IconPlay size={13} />
              <span>Ignite Sprint</span>
            </button>
          ) : phase === 'running' || phase === 'danger' ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setPhase('idle');
                  playSynthesizedSound('beepLow');
                }}
                className="secondary-button"
              >
                <IconPause size={13} />
                <span>Pause</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setSecondsRemaining((prev) => prev + 60);
                  playSynthesizedSound('beepLow');
                }}
                className="secondary-button"
              >
                +1:00
              </button>
              <button
                type="button"
                onClick={handleDetonateNow}
                className="chrome-button bomb-sprint__detonate"
                title="Detonate immediately"
              >
                Detonate
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={handleReset}
              className="primary-button bomb-sprint__primary"
            >
              <IconRotateCcw size={13} />
              <span>Run It Again</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setIsMuted(!isMuted)}
            className="chrome-button"
            title={isMuted ? 'Unmute audio' : 'Mute audio'}
            aria-label={isMuted ? 'Unmute audio' : 'Mute audio'}
          >
            {isMuted ? <IconVolumeX size={14} /> : <IconVolume size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
};
