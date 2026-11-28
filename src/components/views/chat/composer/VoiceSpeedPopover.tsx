import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  VOICE_PLAYBACK_SPEED_PRESETS,
  clampVoicePlaybackSpeed,
} from '../../../../lib/operator/voice/callResilience';
import { getAnchoredPopoverCoords, type PopoverCoords } from './anchoredPosition';
import { composerMenuStyle } from './composerMenu';

export interface VoiceSpeedPopoverProps {
  playbackSpeed: number;
  onChangePlaybackSpeed: (speed: number) => void;
  disabled?: boolean;
  className?: string;
}

export function formatVoiceSpeedDisplay(speed: number): string {
  const safe = clampVoicePlaybackSpeed(speed);
  return Number.isInteger(safe) ? `${safe}.0x` : `${safe}x`;
}

function closestSpeedIndex(speed: number): number {
  const safe = clampVoicePlaybackSpeed(speed);
  let bestIdx = 1; // 1.0x default
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let i = 0; i < VOICE_PLAYBACK_SPEED_PRESETS.length; i += 1) {
    const diff = Math.abs(VOICE_PLAYBACK_SPEED_PRESETS[i] - safe);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

const PANEL_WIDTH = 248;
const PANEL_HEIGHT = 112;

export const VoiceSpeedPopover: React.FC<VoiceSpeedPopoverProps> = ({
  playbackSpeed,
  onChangePlaybackSpeed,
  disabled = false,
  className = '',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [optimisticIndex, setOptimisticIndex] = useState<number | null>(null);
  const [coords, setCoords] = useState<PopoverCoords | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const propIndex = useMemo(() => closestSpeedIndex(playbackSpeed), [playbackSpeed]);

  useEffect(() => {
    setOptimisticIndex(null);
  }, [playbackSpeed]);

  const activeIndex = optimisticIndex ?? propIndex;
  const activeSpeed = VOICE_PLAYBACK_SPEED_PRESETS[activeIndex] ?? 1;
  const displaySpeed =
    optimisticIndex !== null ? activeSpeed : clampVoicePlaybackSpeed(playbackSpeed);
  const formattedSpeed = formatVoiceSpeedDisplay(displaySpeed);
  const maxIdx = VOICE_PLAYBACK_SPEED_PRESETS.length - 1;
  const ratio = maxIdx > 0 ? activeIndex / maxIdx : 0;

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const measuredHeight = panelRef.current?.offsetHeight || PANEL_HEIGHT;
    setCoords(
      getAnchoredPopoverCoords(triggerRef.current, PANEL_WIDTH, measuredHeight, 8, 'top', 'center'),
    );
  }, []);

  useLayoutEffect(() => {
    if (isOpen) {
      updatePosition();
    }
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (
        target &&
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        panelRef.current &&
        !panelRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePosition);
    };
  }, [isOpen, updatePosition]);

  const commitIndex = useCallback(
    (rawIdx: number) => {
      const clamped = Math.max(0, Math.min(maxIdx, Math.round(rawIdx)));
      const preset = VOICE_PLAYBACK_SPEED_PRESETS[clamped] ?? 1;
      setOptimisticIndex(clamped);
      onChangePlaybackSpeed(preset);
    },
    [maxIdx, onChangePlaybackSpeed],
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="voice-speed-trigger"
        data-state={isOpen ? 'open' : 'closed'}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={`Velocidad de reproducción ${formattedSpeed}`}
        title={`Velocidad de reproducción (${formattedSpeed})`}
        disabled={disabled}
        onClick={() => {
          if (!disabled) setIsOpen((prev) => !prev);
        }}
        className={`kite-voice-speed-trigger rounded-pill ${className}`.trim()}
      >
        <span className="kite-voice-speed-trigger__label">{formattedSpeed}</span>
        <svg
          width={10}
          height={10}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="kite-voice-speed-trigger__chevron"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {isOpen &&
        coords &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            data-testid="voice-speed-popover"
            aria-label="Velocidad de reproducción"
            className="kite-floating-card kite-voice-speed-popover"
            style={composerMenuStyle({
              left: `${coords.left}px`,
              top: `${coords.top}px`,
            })}
          >
            <div className="kite-voice-speed-popover__header">
              <span className="kite-voice-speed-popover__title">Velocidad</span>
              <span
                data-testid="voice-speed-readout"
                className="kite-voice-speed-popover__value"
              >
                {formattedSpeed}
              </span>
            </div>

            <div className="kite-voice-speed-track">
              <div
                className="kite-voice-speed-track__fill"
                style={{ width: `calc(10px + (100% - 20px) * ${ratio})` }}
              />
              <div className="kite-voice-speed-track__dots" aria-hidden="true">
                {VOICE_PLAYBACK_SPEED_PRESETS.map((preset, idx) => {
                  const dotRatio = maxIdx > 0 ? idx / maxIdx : 0;
                  const passed = idx <= activeIndex;
                  return (
                    <span
                      key={preset}
                      className={`kite-voice-speed-dot${passed ? ' kite-voice-speed-dot--active' : ''}`}
                      style={{ left: `calc(10px + (100% - 20px) * ${dotRatio})` }}
                    />
                  );
                })}
              </div>
              <div
                className="kite-voice-speed-thumb"
                aria-hidden="true"
                style={{ left: `calc(10px + (100% - 20px) * ${ratio})` }}
              />
              <input
                type="range"
                min={0}
                max={maxIdx}
                step={1}
                value={activeIndex}
                data-testid="voice-speed-slider"
                aria-label="Velocidad de reproducción"
                aria-valuetext={formattedSpeed}
                onChange={(e) => commitIndex(Number(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    commitIndex(activeIndex + 1);
                  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    commitIndex(activeIndex - 1);
                  } else if (e.key === 'Home') {
                    e.preventDefault();
                    commitIndex(0);
                  } else if (e.key === 'End') {
                    e.preventDefault();
                    commitIndex(maxIdx);
                  }
                }}
                className="kite-voice-speed-range"
              />
            </div>

            <div className="kite-voice-speed-ticks">
              {VOICE_PLAYBACK_SPEED_PRESETS.map((preset, idx) => {
                const label = formatVoiceSpeedDisplay(preset);
                const selected = idx === activeIndex;
                return (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => commitIndex(idx)}
                    aria-pressed={selected}
                    className={`kite-voice-speed-tick${selected ? ' kite-voice-speed-tick--active' : ''}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};
