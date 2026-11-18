import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_TERMINAL_APPEARANCE_PREFS } from '../../../../lib/terminalAppearancePrefs';
import {
  DEFAULT_THEME_CUSTOMIZATIONS,
  sanitizeThemeCustomizations,
} from '../../../../lib/themeCustomizations';
import { renderCanvasGrid } from './canvasGridRenderer';
import {
  resolveTerminalCanvasTheme,
  type CellSnapshot,
  type CursorSnapshot,
} from './terminalCanvasTypes';

function recordingCanvas() {
  const fills: { x: number; y: number; w: number; h: number; style: string }[] = [];
  const clears: { x: number; y: number; w: number; h: number }[] = [];
  const texts: { text: string; style: string }[] = [];
  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 60;
  canvas.getBoundingClientRect = () =>
    ({
      width: 200,
      height: 60,
      top: 0,
      left: 0,
      right: 200,
      bottom: 60,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  const ctx = {
    fillStyle: '',
    font: '',
    textBaseline: 'alphabetic',
    textAlign: 'left',
    imageSmoothingEnabled: true,
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    clearRect(x: number, y: number, w: number, h: number) {
      clears.push({ x, y, w, h });
    },
    fillRect(x: number, y: number, w: number, h: number) {
      fills.push({ x, y, w, h, style: this.fillStyle });
    },
    fillText(text: string) {
      texts.push({ text, style: this.fillStyle });
    },
    measureText() {
      return { width: 8 };
    },
    save() {},
    restore() {},
    scale() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fill() {},
    setTransform() {},
    translate() {},
    strokeRect() {},
  };
  canvas.getContext = (() => ctx) as unknown as typeof canvas.getContext;
  return { canvas, fills, clears, texts };
}

const defaultCursor: CursorSnapshot = {
  visible: true,
  col: 1,
  row: 0,
  shape: 'bar',
  blink: true,
};

describe('terminal theme sync', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('resolves terminal bg, fg, cursor, selection, and ANSI palette from active visual theme pack and overrides', () => {
    const atelierState = sanitizeThemeCustomizations({
      ...DEFAULT_THEME_CUSTOMIZATIONS,
      appearanceMode: 'light',
      lightThemeId: 'warm-atelier',
      overrides: {
        ...DEFAULT_THEME_CUSTOMIZATIONS.overrides,
        accent: '#0ea5e9',
      },
    });
    const theme = resolveTerminalCanvasTheme(atelierState);
    expect(theme.bg).toBe('#f7f4ec');
    expect(theme.fg).toBe('#1f1c18');
    expect(theme.cursor).toBe('#0ea5e9');
    expect(theme.ansi[1]).toBe('#dc2626');
  });

  it('repaints canvas background, cursor, selection, and default fg using active theme pack instead of hardcoded dark hex', () => {
    const solarizedState = sanitizeThemeCustomizations({
      ...DEFAULT_THEME_CUSTOMIZATIONS,
      appearanceMode: 'light',
      lightThemeId: 'solarized-light',
    });
    const theme = resolveTerminalCanvasTheme(solarizedState);
    const { canvas, fills, texts } = recordingCanvas();
    const defaultFgCell: CellSnapshot = {
      ch: 'X',
      width: 1,
      fg: [250, 250, 250],
      bg: [10, 10, 10],
      hasBg: false,
      bold: false,
      italic: false,
      underline: false,
      inverse: false,
      dim: false,
    };

    renderCanvasGrid({
      canvas,
      prefs: DEFAULT_TERMINAL_APPEARANCE_PREFS,
      matrix: [[defaultFgCell]],
      cursor: defaultCursor,
      selection: { start: { row: 0, col: 0 }, end: { row: 0, col: 1 } },
      hoveredLink: null,
      isFocused: true,
      scrollbackOffset: 0,
      cellW: 8,
      cellH: 16,
      baseline: 12,
      gridRows: 3,
      gridCols: 4,
      dirtyRows: null,
      cursorBlinkOn: true,
      theme,
    });

    expect(fills[0]?.style).toBe('#fdf6e3');
    expect(fills.some((f) => f.style === theme.selection)).toBe(true);
    expect(fills.some((f) => f.style === '#268bd2')).toBe(true);
    expect(texts.find((t) => t.text === 'X')?.style).toBe('rgb(7,54,66)');
  });

  it('clears canvas via clearRect without painting an opaque background fill when transparentBg is enabled', () => {
    const auroraState = sanitizeThemeCustomizations({
      ...DEFAULT_THEME_CUSTOMIZATIONS,
      appearanceMode: 'dark',
      darkThemeId: 'aurora-studio',
      surface: {
        ...DEFAULT_THEME_CUSTOMIZATIONS.surface,
        translucent: true,
      },
    });
    const theme = resolveTerminalCanvasTheme(auroraState);
    expect(theme.transparentBg).toBe(true);

    const { canvas, fills, clears, texts } = recordingCanvas();
    const cell: CellSnapshot = {
      ch: 'K',
      width: 1,
      fg: [250, 250, 250],
      bg: [10, 10, 10],
      hasBg: false,
      bold: false,
      italic: false,
      underline: false,
      inverse: false,
      dim: false,
    };

    renderCanvasGrid({
      canvas,
      prefs: DEFAULT_TERMINAL_APPEARANCE_PREFS,
      matrix: [[cell]],
      cursor: defaultCursor,
      selection: { start: null, end: null },
      hoveredLink: null,
      isFocused: true,
      scrollbackOffset: 0,
      cellW: 8,
      cellH: 16,
      baseline: 12,
      gridRows: 3,
      gridCols: 4,
      dirtyRows: null,
      cursorBlinkOn: true,
      theme,
    });

    expect(clears).toEqual([{ x: 0, y: 0, w: 200, h: 60 }]);
    expect(fills.some((f) => f.style === theme.bg)).toBe(false);
    expect(fills.some((f) => f.style === theme.cursor)).toBe(true);
    expect(texts.find((t) => t.text === 'K')?.style).toBe('rgb(226,232,240)');

    // Partial dirty-row repaint must clear only the dirty row strip rather than filling opaque theme.bg
    clears.length = 0;
    fills.length = 0;
    renderCanvasGrid({
      canvas,
      prefs: DEFAULT_TERMINAL_APPEARANCE_PREFS,
      matrix: [[cell]],
      cursor: defaultCursor,
      selection: { start: null, end: null },
      hoveredLink: null,
      isFocused: true,
      scrollbackOffset: 0,
      cellW: 8,
      cellH: 16,
      baseline: 12,
      gridRows: 3,
      gridCols: 4,
      dirtyRows: [0],
      cursorBlinkOn: true,
      theme,
    });
    expect(clears).toHaveLength(1);
    expect(clears[0].w).toBe(200);
    expect(clears[0].h).toBe(16);
    expect(fills.some((f) => f.style === theme.bg)).toBe(false);
  });
});
