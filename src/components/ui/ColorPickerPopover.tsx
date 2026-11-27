import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './color-picker-popover.css';

export interface HsvColor {
  h: number;
  s: number;
  v: number;
}

export const DEFAULT_COLOR_PICKER_PRESETS: readonly string[] = [
  '#4ade80',
  '#22c55e',
  '#14b8a6',
  '#22d3ee',
  '#38bdf8',
  '#5c8fff',
  '#6366f1',
  '#8b5cf6',
  '#a78bfa',
  '#d946ef',
  '#f472b6',
  '#fb7185',
  '#ef4444',
  '#f97316',
  '#fbbf24',
  '#eab308',
  '#e2e8f0',
  '#94a3b8',
];

export function normalizeHexColor(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const body = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (/^[0-9a-fA-F]{6}$/.test(body)) {
    return `#${body.toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{3}$/.test(body)) {
    const expanded = body
      .split('')
      .map((ch) => ch + ch)
      .join('');
    return `#${expanded.toLowerCase()}`;
  }
  return null;
}

export function hexToHsv(hex: string): HsvColor {
  const normalized = normalizeHexColor(hex) ?? '#4ade80';
  const r = parseInt(normalized.slice(1, 3), 16) / 255;
  const g = parseInt(normalized.slice(3, 5), 16) / 255;
  const b = parseInt(normalized.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  if (delta > 0) {
    if (max === r) {
      h = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
      h = 60 * ((b - r) / delta + 2);
    } else {
      h = 60 * ((r - g) / delta + 4);
    }
  }
  if (h < 0) h += 360;

  const s = max === 0 ? 0 : (delta / max) * 100;
  const v = max * 100;
  return { h: Math.round(h), s: Math.round(s), v: Math.round(v) };
}

export function hsvToHex(h: number, s: number, v: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const val = Math.max(0, Math.min(100, v)) / 100;

  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hue < 60) {
    r1 = c;
    g1 = x;
  } else if (hue < 120) {
    r1 = x;
    g1 = c;
  } else if (hue < 180) {
    g1 = c;
    b1 = x;
  } else if (hue < 240) {
    g1 = x;
    b1 = c;
  } else if (hue < 300) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  const toByte = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, '0');

  return `#${toByte(r1)}${toByte(g1)}${toByte(b1)}`;
}

export interface ColorPickerPopoverProps {
  value: string;
  onChange: (nextHex: string) => void;
  ariaLabel: string;
  dialogLabel?: string;
  title?: string;
  active?: boolean;
  triggerVariant?: 'compact' | 'chip';
  presets?: readonly string[];
  id?: string;
  className?: string;
}

const POPOVER_WIDTH = 244;
const POPOVER_HEIGHT = 278;
const VIEWPORT_MARGIN = 10;

export const ColorPickerPopover: React.FC<ColorPickerPopoverProps> = ({
  value,
  onChange,
  ariaLabel,
  dialogLabel,
  title,
  active = false,
  triggerVariant = 'compact',
  presets = DEFAULT_COLOR_PICKER_PRESETS,
  id,
  className = '',
}) => {
  const safeHex = normalizeHexColor(value) ?? '#4ade80';
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState<HsvColor>(() => hexToHsv(safeHex));
  const [hexDraft, setHexDraft] = useState(safeHex);
  const [coords, setCoords] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const padRef = useRef<HTMLDivElement>(null);
  const draggingPadRef = useRef(false);

  useEffect(() => {
    setHsv(hexToHsv(safeHex));
    setHexDraft(safeHex);
  }, [safeHex]);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;

    let left = rect.right - POPOVER_WIDTH;
    if (left < VIEWPORT_MARGIN) {
      left = Math.min(rect.left, vw - POPOVER_WIDTH - VIEWPORT_MARGIN);
    }
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - POPOVER_WIDTH - VIEWPORT_MARGIN));

    const spaceBelow = vh - rect.bottom - VIEWPORT_MARGIN;
    const top =
      spaceBelow >= POPOVER_HEIGHT || rect.top < POPOVER_HEIGHT
        ? Math.min(rect.bottom + 8, vh - POPOVER_HEIGHT - VIEWPORT_MARGIN)
        : Math.max(VIEWPORT_MARGIN, rect.top - POPOVER_HEIGHT - 8);

    setCoords({ left: Math.round(left), top: Math.round(top) });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (
        target &&
        (popoverRef.current?.contains(target) || triggerRef.current?.contains(target))
      ) {
        return;
      }
      setOpen(false);
    };
    const handleResize = () => reposition();

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleResize, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleResize, true);
    };
  }, [open, reposition]);

  const commitHsv = useCallback(
    (next: HsvColor) => {
      setHsv(next);
      const nextHex = hsvToHex(next.h, next.s, next.v);
      setHexDraft(nextHex);
      onChange(nextHex);
    },
    [onChange]
  );

  const updateFromPadPointer = useCallback(
    (clientX: number, clientY: number) => {
      const pad = padRef.current;
      if (!pad) return;
      const rect = pad.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const s = Math.max(0, Math.min(100, Math.round(((clientX - rect.left) / rect.width) * 100)));
      const v = Math.max(
        0,
        Math.min(100, Math.round((1 - (clientY - rect.top) / rect.height) * 100))
      );
      commitHsv({ h: hsv.h, s, v });
    },
    [commitHsv, hsv.h]
  );

  const handlePadPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingPadRef.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // JSDOM or environments without pointer capture.
    }
    updateFromPadPointer(e.clientX, e.clientY);
  };

  const handlePadPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingPadRef.current) return;
    updateFromPadPointer(e.clientX, e.clientY);
  };

  const handlePadPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingPadRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore if capture was not held.
    }
  };

  const handleHexChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setHexDraft(raw);
    const trimmed = raw.trim();
    const digits = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
    if (/^[0-9a-fA-F]{6}$/.test(digits)) {
      const next = `#${digits.toLowerCase()}`;
      setHsv(hexToHsv(next));
      onChange(next);
    }
  };

  const handleHexCommit = () => {
    const normalized = normalizeHexColor(hexDraft);
    if (normalized) {
      setHexDraft(normalized);
      setHsv(hexToHsv(normalized));
      onChange(normalized);
    } else {
      setHexDraft(safeHex);
    }
  };

  const popoverNode = open ? (
    <div
      ref={popoverRef}
      aria-label={dialogLabel ?? ariaLabel}
      className="kite-color-popover"
      data-testid="color-picker-popover"
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      style={
        {
          '--popover-left': `${coords.left}px`,
          '--popover-top': `${coords.top}px`,
        } as React.CSSProperties
      }
    >
      <div
        ref={padRef}
        aria-label="Saturación y brillo"
        className="kite-color-popover__pad"
        onPointerDown={handlePadPointerDown}
        onPointerMove={handlePadPointerMove}
        onPointerUp={handlePadPointerUp}
        style={{ '--picker-hue': String(hsv.h) } as React.CSSProperties}
      >
        <span
          aria-hidden="true"
          className="kite-color-popover__thumb"
          style={
            {
              '--thumb-x': `${hsv.s}%`,
              '--thumb-y': `${100 - hsv.v}%`,
              '--swatch-color': safeHex,
            } as React.CSSProperties
          }
        />
      </div>

      <div className="kite-color-popover__hue-row">
        <input
          aria-label="Tono"
          className="kite-color-popover__hue"
          max={360}
          min={0}
          onChange={(e) => commitHsv({ h: Number(e.target.value), s: hsv.s, v: hsv.v })}
          type="range"
          value={hsv.h}
        />
      </div>

      <div className="kite-color-popover__swatches" role="group" aria-label="Colores rápidos">
        {presets.map((presetHex) => {
          const normalizedPreset = normalizeHexColor(presetHex) ?? presetHex;
          const isSelected = normalizedPreset === safeHex;
          return (
            <button
              key={normalizedPreset}
              aria-label={`Elegir ${normalizedPreset}`}
              aria-pressed={isSelected}
              className="kite-color-popover__swatch"
              onClick={() => {
                setHsv(hexToHsv(normalizedPreset));
                setHexDraft(normalizedPreset);
                onChange(normalizedPreset);
              }}
              title={normalizedPreset}
              type="button"
            >
              <span
                aria-hidden="true"
                className="kite-color-popover__swatch-dot"
                style={{ '--swatch-color': normalizedPreset } as React.CSSProperties}
              />
            </button>
          );
        })}
      </div>

      <div className="kite-color-popover__hex-row">
        <span
          aria-hidden="true"
          className="kite-color-popover__preview"
          style={{ '--swatch-color': safeHex } as React.CSSProperties}
        />
        <input
          aria-label="Código hexadecimal"
          className="kite-color-popover__hex-input"
          maxLength={7}
          onBlur={handleHexCommit}
          onChange={handleHexChange}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              handleHexCommit();
              setOpen(false);
            }
          }}
          placeholder="#4ade80"
          spellCheck={false}
          type="text"
          value={hexDraft}
        />
      </div>
    </div>
  ) : null;

  const portalTarget =
    typeof document !== 'undefined'
      ? document.querySelector('.app-frame--scaled') ?? document.body
      : null;

  return (
    <>
      <button
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={ariaLabel}
        className={`kite-color-trigger kite-color-trigger--${triggerVariant}${
          active ? ' kite-color-trigger--active' : ''
        } ${className}`.trim()}
        id={id}
        onClick={() => setOpen((prev) => !prev)}
        title={title ?? ariaLabel}
        type="button"
      >
        <span
          aria-hidden="true"
          className="kite-color-trigger__swatch"
          style={{ '--swatch-color': safeHex } as React.CSSProperties}
        />
        <span aria-hidden="true" className="kite-color-trigger__pip">
          <svg width="7" height="7" viewBox="0 0 12 12" fill="none">
            <path
              d="M3 4.5L6 7.5L9 4.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      {popoverNode && portalTarget ? createPortal(popoverNode, portalTarget) : popoverNode}
    </>
  );
};
