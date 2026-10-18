import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { BrainIcon, ChevronsUpDownIcon } from './ChatIcons';
import { EffortChoice, DEFAULT_EFFORT_CHOICES } from './types';

export interface EffortPickerProps {
  choices?: EffortChoice[];
  value?: string | null;
  onSelect: (choiceId: string) => void;
  disabled?: boolean;
  label?: string;
  help?: string;
  detail?: string;
  variant?: 'toolbar' | 'field';
  placement?: 'top' | 'bottom';
}

const BASE_PADDING = 13; // 13px padding offset from rail
const PANEL_WIDTH = 322;
const GAP = 8;
const MARGIN_BOTTOM = 12;

function getStopPosition(index: number, total: number): string {
  if (total <= 1) return `${BASE_PADDING}px`;
  const ratio = index / (total - 1);
  return `calc(${BASE_PADDING}px + (100% - 26px) * ${ratio})`;
}

function getAnchoredGeometry(element: HTMLElement) {
  const scaledHost = element.closest('.app-frame--scaled') as HTMLElement | null;
  const hostRect = scaledHost?.getBoundingClientRect();
  const rawScale = Number(scaledHost ? window.getComputedStyle(scaledHost).getPropertyValue('--ui-scale') : 1);
  const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
  const originX = hostRect?.left ?? 0;
  const originY = hostRect?.top ?? 0;
  const rect = element.getBoundingClientRect();

  return {
    bounds: {
      left: (rect.left - originX) / scale,
      top: (rect.top - originY) / scale,
      right: (rect.right - originX) / scale,
      bottom: (rect.bottom - originY) / scale,
      width: rect.width / scale,
      height: rect.height / scale,
    },
    viewport: {
      left: -originX / scale,
      top: -originY / scale,
      right: (window.innerWidth - originX) / scale,
      bottom: (window.innerHeight - originY) / scale,
      width: window.innerWidth / scale,
      height: window.innerHeight / scale,
    },
    portalHost: scaledHost ?? document.body,
  };
}

export const EffortPicker: React.FC<EffortPickerProps> = ({
  choices = DEFAULT_EFFORT_CHOICES,
  value,
  onSelect,
  disabled = false,
  label = 'Reasoning effort',
  help,
  detail = 'How long the model thinks before it answers.',
  variant = 'toolbar',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [coords, setCoords] = useState<{
    left: number;
    top: number;
    origin: 'top' | 'bottom';
  } | null>(null);
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const selectedIndex = Math.max(
    0,
    choices.findIndex((c) => c.id === value)
  );
  const currentChoice = choices[selectedIndex] || choices[0];

  const totalChoices = choices.length;
  const levelPercent = totalChoices > 0 ? ((selectedIndex + 1) / totalChoices) * 100 : 0;
  const thumbLeft = getStopPosition(selectedIndex, totalChoices);

  const closeMenu = useCallback((restoreFocus = true) => {
    setIsOpen(false);
    setCoords(null);
    setPanelEl(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const openMenu = useCallback(() => {
    if (disabled) return;
    setIsOpen(true);
  }, [disabled]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const { bounds, viewport } = getAnchoredGeometry(trigger);
    const left = Math.max(
      viewport.left + GAP,
      Math.min(bounds.left, viewport.right - PANEL_WIDTH - GAP)
    );

    const panelHeight = panelEl ? panelEl.offsetHeight : 140;
    const spaceBelow = viewport.bottom - bounds.bottom - MARGIN_BOTTOM - GAP;
    const spaceAbove = bounds.top - viewport.top - MARGIN_BOTTOM - GAP;

    // Prefer above if within composer, or if space below is limited
    const placeAbove = panelHeight > spaceBelow && (panelHeight <= spaceAbove || spaceAbove > spaceBelow);
    const top = placeAbove
      ? Math.max(viewport.top + GAP, bounds.top - MARGIN_BOTTOM - panelHeight)
      : bounds.bottom + GAP;

    setCoords((prev) => {
      if (prev && prev.left === left && prev.top === top && prev.origin === (placeAbove ? 'bottom' : 'top')) {
        return prev;
      }
      return {
        left,
        top,
        origin: placeAbove ? 'bottom' : 'top',
      };
    });
  }, [panelEl]);

  useLayoutEffect(() => {
    if (isOpen) {
      updatePosition();
    }
  }, [isOpen, updatePosition]);

  useLayoutEffect(() => {
    if (!isOpen || !panelEl || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(updatePosition);
    ro.observe(panelEl);
    if (triggerRef.current) ro.observe(triggerRef.current);
    const scaledHost = triggerRef.current?.closest('.app-frame--scaled');
    if (scaledHost) ro.observe(scaledHost);
    return () => ro.disconnect();
  }, [isOpen, panelEl, updatePosition]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        panelRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      closeMenu(false);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Tab') {
        closeMenu(true);
      }
    };

    const handleReposition = () => updatePosition();

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [isOpen, closeMenu, updatePosition]);

  const handleSelectIndex = useCallback(
    (index: number) => {
      const clamped = Math.min(Math.max(0, index), totalChoices - 1);
      const chosen = choices[clamped];
      if (chosen && chosen.id !== value) {
        onSelect(chosen.id);
      }
    },
    [choices, onSelect, totalChoices, value]
  );

  const calculateIndexFromPointer = useCallback(
    (clientX: number): number => {
      const rail = railRef.current;
      if (!rail || totalChoices < 2) return 0;
      const rect = rail.getBoundingClientRect();
      const trackWidth = Math.max(rect.width - BASE_PADDING * 2, 1);
      const relativeX = Math.min(Math.max(clientX - rect.left - BASE_PADDING, 0), trackWidth);
      return Math.round((relativeX / trackWidth) * (totalChoices - 1));
    },
    [totalChoices]
  );

  const handleRailPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    railRef.current?.focus();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setIsDragging(true);
    handleSelectIndex(calculateIndexFromPointer(e.clientX));
  };

  const handleRailPointerMove = (e: React.PointerEvent) => {
    if (!isDragging) return;
    handleSelectIndex(calculateIndexFromPointer(e.clientX));
  };

  const handleRailPointerUp = (e: React.PointerEvent) => {
    if (!isDragging) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    setIsDragging(false);
    handleSelectIndex(calculateIndexFromPointer(e.clientX));
  };

  const handleRailKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        e.preventDefault();
        handleSelectIndex(selectedIndex - 1);
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        e.preventDefault();
        handleSelectIndex(selectedIndex + 1);
        break;
      case 'Home':
        e.preventDefault();
        handleSelectIndex(0);
        break;
      case 'End':
        e.preventDefault();
        handleSelectIndex(totalChoices - 1);
        break;
      case 'Enter':
        e.preventDefault();
        closeMenu(true);
        break;
    }
  };

  const portalHost = triggerRef.current ? getAnchoredGeometry(triggerRef.current).portalHost : document.body;

  const triggerClasses = [
    'select-menu-trigger',
    `select-menu-trigger--${variant}`,
    'effort-trigger',
    isOpen ? 'select-menu-trigger--open' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        title={help ?? `Adjust ${label.toLowerCase()}`}
        disabled={disabled}
        onClick={() => (isOpen ? closeMenu(true) : openMenu())}
        onKeyDown={(e) => {
          if (!isOpen && !disabled && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            openMenu();
          }
        }}
        className={triggerClasses}
      >
        <span aria-hidden="true" className="select-menu-trigger__icon effort-trigger__icon">
          <BrainIcon size={12} strokeWidth={2.25} />
        </span>
        <span className="select-menu-trigger__label">
          {currentChoice?.label ?? 'Automatic'}
        </span>
        <ChevronsUpDownIcon aria-hidden="true" className="effort-trigger__chevron" size={10} />
      </button>

      {isOpen && coords &&
        createPortal(
          <div
            id={menuId}
            ref={(node) => {
              panelRef.current = node;
              setPanelEl(node);
            }}
            role="dialog"
            aria-label={label}
            data-select-menu="true"
            className={`select-menu select-menu--from-${coords.origin} effort-panel`}
            style={{
              position: 'fixed',
              left: `${coords.left}px`,
              top: `${coords.top}px`,
              width: `${PANEL_WIDTH}px`,
              zIndex: 60,
            } as React.CSSProperties}
          >
            {/* Header */}
            <div className="effort-panel__header">
              <div className="effort-panel__heading">
                <span className="effort-panel__title">{label}</span>
                <span className="effort-panel__detail">
                  {currentChoice?.detail ?? detail}
                </span>
              </div>

              {/* Effort Gauge */}
              <span aria-hidden="true" className="effort-gauge">
                <span className="effort-gauge__glyph">
                  <BrainIcon className="effort-gauge__outline" size={13} strokeWidth={2.25} />
                  <span
                    className="effort-gauge__level"
                    style={{ height: `${levelPercent}%` }}
                  >
                    <BrainIcon fill="currentColor" size={13} strokeWidth={2.25} />
                  </span>
                </span>
              </span>
            </div>

            {/* Slider */}
            <div className="effort-slider" data-dragging={isDragging ? 'true' : undefined}>
              <div
                ref={railRef}
                role="slider"
                tabIndex={0}
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={Math.max(totalChoices - 1, 0)}
                aria-valuenow={selectedIndex}
                aria-valuetext={currentChoice?.label ?? 'Automatic'}
                className="effort-slider__rail"
                onPointerDown={handleRailPointerDown}
                onPointerMove={handleRailPointerMove}
                onPointerUp={handleRailPointerUp}
                onPointerCancel={handleRailPointerUp}
                onKeyDown={handleRailKeyDown}
              >
                <span className="effort-slider__track" />
                <span
                  className="effort-slider__fill"
                  style={{ width: `max(${thumbLeft}, 22px)` }}
                />

                {choices.map((c, i) =>
                  i === selectedIndex ? null : (
                    <i
                      key={c.id}
                      className="effort-slider__stop"
                      data-behind={i < selectedIndex ? 'true' : undefined}
                      style={{ left: getStopPosition(i, totalChoices) }}
                    />
                  )
                )}

                <span
                  className="effort-slider__thumb"
                  style={{ left: thumbLeft }}
                />
              </div>

              {/* Slider Labels */}
              <div aria-hidden="true" className="effort-slider__labels">
                <span
                  className="effort-slider__end"
                  data-hidden={selectedIndex === 0 ? 'true' : undefined}
                >
                  {choices[0]?.label}
                </span>
                <span
                  className="effort-slider__end effort-slider__end--last"
                  data-hidden={selectedIndex === totalChoices - 1 ? 'true' : undefined}
                >
                  {choices[totalChoices - 1]?.label}
                </span>
                <span
                  className="effort-slider__value"
                  data-edge={
                    selectedIndex === 0
                      ? 'start'
                      : selectedIndex === totalChoices - 1
                      ? 'end'
                      : undefined
                  }
                  style={
                    selectedIndex === 0 || selectedIndex === totalChoices - 1
                      ? undefined
                      : { left: thumbLeft }
                  }
                >
                  {currentChoice?.label}
                </span>
              </div>
            </div>
          </div>,
          portalHost
        )}
    </>
  );
};
