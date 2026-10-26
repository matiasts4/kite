import React, {
  useState,
  useRef,
  useMemo,
  useEffect,
  useCallback,
  useLayoutEffect,
} from 'react';
import { createPortal } from 'react-dom';
import { DriverDeclaration, DriverChoice } from '../../../../lib/session/types';
import { ZapIcon, ChevronRightIcon } from '../ChatIcons';
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from './ComposerControl';
import { getAnchoredPopoverCoords, PopoverCoords } from './anchoredPosition';

const ResetSvg: React.FC<{ size?: number; className?: string }> = ({ size = 13, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
  </svg>
);

export interface EffortSliderPopoverProps {
  effort?: string | null;
  modelName: string;
  declaration: DriverDeclaration;
  disabled?: boolean;
  unlistedReason?: string | null;
  onChangeEffort: (effortId: string) => void;
}

const SPANISH_EFFORT_LABELS: Record<string, string> = {
  low: 'Bajo',
  medium: 'Medio',
  high: 'Alto',
  max: 'Máximo',
};

const PANEL_WIDTH = 272;
const PANEL_HEIGHT = 140;

export const EffortSliderPopover: React.FC<EffortSliderPopoverProps> = ({
  effort,
  modelName,
  declaration,
  disabled = false,
  unlistedReason,
  onChangeEffort,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [optimisticIndex, setOptimisticIndex] = useState<number | null>(null);
  const [coords, setCoords] = useState<PopoverCoords | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const steps = useMemo(() => {
    if (declaration.effort && declaration.effort.length > 0) {
      return declaration.effort;
    }
    return [
      { id: 'low', label: 'Bajo', detail: 'Fast responses with minimal reasoning' },
      { id: 'medium', label: 'Medio', detail: 'Balanced reasoning effort for standard tasks' },
      { id: 'high', label: 'Alto', detail: 'Deep reasoning and thorough code analysis' },
      { id: 'max', label: 'Máximo', detail: 'Maximum reasoning and exhaustive verification' },
    ];
  }, [declaration.effort]);

  const defaultStepId = declaration.defaultEffort || 'medium';
  const effectiveEffortId = effort || defaultStepId;

  const activeIndex = useMemo(() => {
    const idx = steps.findIndex((s: DriverChoice) => s.id === effectiveEffortId);
    if (idx >= 0) return idx;
    const lower = effectiveEffortId.toLowerCase();
    const fallbackIdx = steps.findIndex((s: DriverChoice) => s.id.toLowerCase() === lower);
    return fallbackIdx >= 0 ? fallbackIdx : Math.min(1, steps.length - 1);
  }, [steps, effectiveEffortId]);

  // Keep optimistic state synced with external prop updates when not dragging
  useEffect(() => {
    if (!isDragging) {
      setOptimisticIndex(null);
    }
  }, [effectiveEffortId, isDragging]);

  const displayIndex = optimisticIndex !== null ? optimisticIndex : activeIndex;
  const activeStep = steps[displayIndex] || steps[0];
  const activeLabel =
    SPANISH_EFFORT_LABELS[activeStep.id.toLowerCase()] || activeStep.label;

  const percent = steps.length > 1 ? (displayIndex / (steps.length - 1)) * 100 : 50;

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    setCoords(getAnchoredPopoverCoords(triggerRef.current, PANEL_WIDTH, PANEL_HEIGHT, 8, 'top'));
  }, []);

  useLayoutEffect(() => {
    if (isOpen) {
      updatePosition();
    }
  }, [isOpen, updatePosition]);

  // Close on outside click or escape
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
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
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePosition);
    };
  }, [isOpen, updatePosition]);

  const handleSelectIndex = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, steps.length - 1));
      const target = steps[clamped];
      if (target) {
        setOptimisticIndex(clamped);
        onChangeEffort(target.id);
      }
    },
    [steps, onChangeEffort]
  );

  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || steps.length <= 1) return;
    e.preventDefault();
    setIsDragging(true);

    const computeIndex = (clientX: number) => {
      if (!trackRef.current) return displayIndex;
      const rect = trackRef.current.getBoundingClientRect();
      const relativeX = clientX - rect.left;
      const ratio = Math.max(0, Math.min(relativeX / rect.width, 1));
      return Math.max(0, Math.min(Math.round(ratio * (steps.length - 1)), steps.length - 1));
    };

    let currentIndex = computeIndex(e.clientX);
    setOptimisticIndex(currentIndex);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextIndex = computeIndex(moveEvent.clientX);
      if (nextIndex !== currentIndex) {
        currentIndex = nextIndex;
        setOptimisticIndex(nextIndex);
      }
    };

    const handlePointerUp = () => {
      setIsDragging(false);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      const target = steps[currentIndex];
      if (target) {
        onChangeEffort(target.id);
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  const handleReset = (e: React.MouseEvent) => {
    e.stopPropagation();
    const defaultIdx = steps.findIndex((s) => s.id === defaultStepId);
    if (defaultIdx >= 0) setOptimisticIndex(defaultIdx);
    onChangeEffort(defaultStepId);
  };

  const triggerTitle = unlistedReason || `Reasoning effort: ${activeLabel}`;

  return (
    <>
      {/* Trigger Pill */}
      <ComposerControl
        ref={triggerRef}
        role="combobox"
        aria-label="Reasoning effort"
        aria-expanded={isOpen}
        title={triggerTitle}
        disabled={disabled || Boolean(unlistedReason)}
        data-state={isOpen ? 'open' : 'closed'}
        onClick={() => {
          if (!disabled && !unlistedReason) {
            setIsOpen((prev) => !prev);
          }
        }}
      >
        <ComposerControlIcon icon={ZapIcon} size={14} className="text-primary" />
        <span className="truncate max-w-[120px]">{activeLabel}</span>
        <ComposerControlChevron />
      </ComposerControl>

      {/* Screen reader reason */}
      {unlistedReason && <span className="sr-only">{unlistedReason}</span>}

      {/* Floating Card Popover via Portal */}
      {isOpen &&
        coords &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Reasoning effort slider"
            className="kite-floating-card kite-effort-slider-card"
            style={{
              left: `${coords.left}px`,
              top: `${coords.top}px`,
            }}
          >
            {/* Header Row */}
            <div className="kite-effort-header-row">
              {/* Left: Zap Icon matching screenshot */}
              <div className="kite-effort-zap-icon">
                <ZapIcon size={16} />
              </div>

              {/* Center: Title + Model Subtitle with Chevron */}
              <div className="kite-effort-title-wrap">
                <span className="kite-effort-title">{activeLabel}</span>
                <span className="kite-effort-subtitle">
                  <span>{modelName}</span>
                  <ChevronRightIcon size={11} className="opacity-70" />
                </span>
              </div>

              {/* Right: Reset Button */}
              <button
                type="button"
                title="Reset to default effort"
                aria-label="Reset to default effort"
                onClick={handleReset}
                className="kite-effort-reset-btn"
              >
                <ResetSvg size={13} />
              </button>
            </div>

            {/* Slider Track with 4 Discrete Step Dots & Thumb */}
            <div
              ref={trackRef}
              role="slider"
              tabIndex={0}
              aria-label="Reasoning effort"
              aria-valuemin={0}
              aria-valuemax={steps.length - 1}
              aria-valuenow={displayIndex}
              aria-valuetext={activeLabel}
              onPointerDown={handleTrackPointerDown}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  handleSelectIndex(displayIndex + 1);
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  handleSelectIndex(displayIndex - 1);
                } else if (e.key === 'Home') {
                  e.preventDefault();
                  handleSelectIndex(0);
                } else if (e.key === 'End') {
                  e.preventDefault();
                  handleSelectIndex(steps.length - 1);
                }
              }}
              className={`kite-effort-track-wrap ${isDragging ? 'kite-effort-track-wrap--dragging' : ''}`}
            >
              {/* Blue Filled Progress */}
              <div
                className="kite-effort-track-progress"
                style={{ width: `${percent}%` }}
              />

              {/* Discrete Step Dots */}
              <div className="kite-effort-dots-row">
                {steps.map((s: DriverChoice, idx: number) => (
                  <span
                    key={s.id}
                    className="kite-effort-dot"
                    style={{
                      opacity: idx <= displayIndex ? 0.9 : 0.35,
                    }}
                  />
                ))}
              </div>

              {/* Draggable Circle Thumb */}
              <div
                className="kite-effort-thumb"
                style={{
                  left: `${percent}%`,
                  cursor: isDragging ? 'grabbing' : 'grab',
                }}
              />
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
