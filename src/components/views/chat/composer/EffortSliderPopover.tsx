import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { BrainIcon } from '../ChatIcons';
import { ComposerControl, ComposerControlIcon, ComposerControlChevron } from './ComposerControl';
import type { DriverDeclaration, DriverChoice } from '../../../../lib/session/types';

export interface EffortSliderPopoverProps {
  effort: string | null | undefined;
  modelName?: string;
  declaration: DriverDeclaration;
  disabled?: boolean;
  unlistedReason?: string | null;
  onChangeEffort: (effortId: string | null) => void;
}

const ZapSvg: React.FC<{ size?: number; className?: string }> = ({ size = 15, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

const ResetSvg: React.FC<{ size?: number; className?: string }> = ({ size = 14, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

const ChevronRightSvg: React.FC<{ size?: number; className?: string }> = ({ size = 12, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="m9 18 6-6-6-6" />
  </svg>
);

const SPANISH_EFFORT_LABELS: Record<string, string> = {
  none: 'Ninguno',
  low: 'Bajo',
  medium: 'Medio',
  high: 'Alto',
  max: 'Máximo',
  extra: 'Máximo',
};

export const EffortSliderPopover: React.FC<EffortSliderPopoverProps> = ({
  effort,
  modelName = 'GPT-6 Luna',
  declaration,
  disabled = false,
  unlistedReason,
  onChangeEffort,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  // Available steps from declaration or defaults
  const steps: DriverChoice[] = useMemo(() => {
    if (declaration.effort && declaration.effort.length > 0) {
      return declaration.effort;
    }
    // Default 4-step scale matching Codex standard: Low, Medium, High, Max
    return [
      { id: 'low', label: 'Bajo', detail: 'Faster replies with focused thinking' },
      { id: 'medium', label: 'Medio', detail: 'Balanced reasoning for everyday coding' },
      { id: 'high', label: 'Alto', detail: 'Deep multi-step reasoning and verification' },
      { id: 'max', label: 'Máximo', detail: 'Maximum reasoning and exhaustive verification' },
    ];
  }, [declaration.effort]);

  const defaultStepId = declaration.defaultEffort || 'medium';
  const effectiveEffortId = effort || defaultStepId;

  const activeIndex = useMemo(() => {
    const idx = steps.findIndex((s) => s.id === effectiveEffortId);
    if (idx >= 0) return idx;
    // Map case-insensitively or fallback to mid
    const lower = effectiveEffortId.toLowerCase();
    const fallbackIdx = steps.findIndex((s) => s.id.toLowerCase() === lower);
    return fallbackIdx >= 0 ? fallbackIdx : Math.min(1, steps.length - 1);
  }, [steps, effectiveEffortId]);

  const activeStep = steps[activeIndex] || steps[0];
  const activeLabel =
    SPANISH_EFFORT_LABELS[activeStep.id.toLowerCase()] || activeStep.label;

  // Percentage calculation for progress track and thumb (0 to 100)
  const percent = steps.length > 1 ? (activeIndex / (steps.length - 1)) * 100 : 50;

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleSelectIndex = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, steps.length - 1));
      const target = steps[clamped];
      if (target) {
        onChangeEffort(target.id);
      }
    },
    [steps, onChangeEffort]
  );

  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || steps.length <= 1) return;
    e.preventDefault();
    setIsDragging(true);

    const updateFromPosition = (clientX: number) => {
      if (!trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      const relativeX = clientX - rect.left;
      const ratio = Math.max(0, Math.min(relativeX / rect.width, 1));
      const targetIndex = Math.round(ratio * (steps.length - 1));
      handleSelectIndex(targetIndex);
    };

    updateFromPosition(e.clientX);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateFromPosition(moveEvent.clientX);
    };

    const handlePointerUp = () => {
      setIsDragging(false);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  const handleReset = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChangeEffort(defaultStepId);
  };

  const triggerTitle = unlistedReason || `Reasoning effort: ${activeLabel}`;

  return (
    <div ref={containerRef} className="relative inline-block">
      {/* Trigger Pill */}
      <ComposerControl
        role="combobox"
        aria-label="Reasoning effort"
        aria-expanded={isOpen}
        title={triggerTitle}
        disabled={disabled || Boolean(unlistedReason)}
        data-state={isOpen ? 'open' : 'closed'}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <ComposerControlIcon icon={BrainIcon} size={14} className="opacity-80" />
        <span className="truncate max-w-[120px]">{activeLabel}</span>
        <ComposerControlChevron />
      </ComposerControl>

      {/* Unlisted reason inline explanation for screen readers/tests */}
      {unlistedReason && <span className="sr-only">{unlistedReason}</span>}

      {/* Discrete Slider Card Popover (Faithful to Screenshot) */}
      {isOpen && !disabled && (
        <div
          role="dialog"
          aria-label="Reasoning effort slider"
          className="kite-effort-slider-card absolute bottom-[calc(100%+8px)] left-0 animate-in fade-in zoom-in-95 duration-100"
        >
          {/* Header Row */}
          <div className="kite-effort-header-row">
            {/* Left: Lightning / Sparkles icon */}
            <div className="size-6 inline-flex items-center justify-center text-muted-foreground/80">
              <ZapSvg size={16} />
            </div>

            {/* Center: Title + Model Subtitle with Chevron */}
            <div className="kite-effort-title-wrap">
              <span className="kite-effort-title">{activeLabel}</span>
              <span className="kite-effort-subtitle">
                <span>{modelName}</span>
                <ChevronRightSvg size={11} className="opacity-70" />
              </span>
            </div>

            {/* Right: Reset Button */}
            <button
              type="button"
              title="Reset to default effort"
              aria-label="Reset to default effort"
              onClick={handleReset}
              className="size-6 inline-flex items-center justify-center rounded-xs text-muted-foreground/70 hover:text-foreground hover:bg-white/5 border-0 bg-transparent cursor-pointer transition-colors"
            >
              <ResetSvg size={14} />
            </button>
          </div>

          {/* Slider Track with Snap Dots and Progress Fill */}
          <div
            ref={trackRef}
            role="slider"
            aria-valuemin={0}
            aria-valuemax={steps.length - 1}
            aria-valuenow={activeIndex}
            aria-valuetext={activeLabel}
            tabIndex={0}
            onPointerDown={handleTrackPointerDown}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                e.preventDefault();
                handleSelectIndex(activeIndex + 1);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                e.preventDefault();
                handleSelectIndex(activeIndex - 1);
              } else if (e.key === 'Home') {
                e.preventDefault();
                handleSelectIndex(0);
              } else if (e.key === 'End') {
                e.preventDefault();
                handleSelectIndex(steps.length - 1);
              }
            }}
            className="kite-effort-track-wrap"
          >
            {/* Blue Progress Track */}
            <div
              className="kite-effort-track-progress"
              style={{ width: `${percent}%` }}
            />

            {/* Discrete Dot Steps */}
            <div className="kite-effort-dots-row">
              {steps.map((step, idx) => (
                <div
                  key={step.id}
                  className="kite-effort-dot"
                  style={{
                    backgroundColor: idx <= activeIndex ? '#ffffff' : undefined,
                    opacity: idx === activeIndex ? 0 : 0.6,
                  }}
                />
              ))}
            </div>

            {/* Draggable Circular Thumb */}
            <div
              className="kite-effort-thumb"
              style={{
                left: `${percent}%`,
                transition: isDragging ? 'none' : undefined,
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
};
