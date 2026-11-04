import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_APPEARANCE_PREFS } from '../../../../lib/terminalAppearancePrefs';
import { renderCanvasGrid } from './canvasGridRenderer';
import type { CellSnapshot, CursorSnapshot } from './terminalCanvasTypes';

function cell(ch: string): CellSnapshot {
  return {
    ch,
    width: 1,
    fg: [200, 200, 200],
    bg: [0, 0, 0],
    hasBg: false,
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
    dim: false,
  };
}

function recordingCanvas() {
  const fills: { x: number; y: number; w: number; h: number }[] = [];
  const texts: string[] = [];
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
      toJSON() {
        return {};
      },
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
    fillRect(x: number, y: number, w: number, h: number) {
      fills.push({ x, y, w, h });
    },
    fillText(text: string) {
      texts.push(text);
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
  return { canvas, fills, texts };
}

const cursor: CursorSnapshot = {
  visible: true,
  col: 0,
  row: 0,
  shape: 'bar',
  blink: true,
};

function baseState(
  canvas: HTMLCanvasElement,
  dirtyRows: number[] | null,
  onPaintRow?: (row: number) => void,
) {
  return {
    canvas,
    prefs: DEFAULT_TERMINAL_APPEARANCE_PREFS,
    matrix: [[cell('A')], [cell('B')], [cell('C')]],
    cursor,
    selection: { start: null, end: null },
    hoveredLink: null,
    isFocused: true,
    scrollbackOffset: 0,
    cellW: 8,
    cellH: 16,
    baseline: 12,
    gridRows: 3,
    gridCols: 4,
    dirtyRows,
    cursorBlinkOn: true,
    onPaintRow,
  };
}

function clearsViewport(fills: { x: number; y: number; w: number; h: number }[]) {
  return fills.some((fill) => fill.x === 0 && fill.y === 0 && fill.w >= 200 && fill.h >= 60);
}

describe('renderCanvasGrid dirty rows', () => {
  it('paints only the dirty row and does not clear the viewport', () => {
    const { canvas, fills, texts } = recordingCanvas();
    const painted: number[] = [];
    renderCanvasGrid(baseState(canvas, [1], (row) => painted.push(row)));
    expect(painted).toEqual([1]);
    expect(clearsViewport(fills)).toBe(false);
    expect(texts).toContain('B');
    expect(texts).not.toContain('A');
    expect(texts).not.toContain('C');
  });

  it('clears the viewport on a full paint', () => {
    const { canvas, fills, texts } = recordingCanvas();
    renderCanvasGrid(baseState(canvas, null));
    expect(clearsViewport(fills)).toBe(true);
    expect(texts).toEqual(expect.arrayContaining(['A', 'B', 'C']));
  });
});
