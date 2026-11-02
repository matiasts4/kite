import { resolveTerminalFontFamily, getTerminalAppearancePrefs, type TerminalAppearancePrefs } from '../../../../lib/terminalAppearancePrefs';

export interface CellSnapshot {
  ch: string;
  width: number;
  fg: [number, number, number];
  bg: [number, number, number];
  hasBg: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  dim: boolean;
}

export interface RowSnapshot {
  rowIdx: number;
  cells: CellSnapshot[];
}

export interface CursorSnapshot {
  visible: boolean;
  col: number;
  row: number;
  shape: string; // 'bar' | 'block' | 'underline'
  blink?: boolean;
}

export type TerminalMouseMode = 'none' | 'click' | 'drag' | 'any';

export interface RenderSnapshot {
  seq: number;
  cols: number;
  rows: number;
  alternateScreen: boolean;
  applicationCursor?: boolean;
  bracketedPaste?: boolean;
  mouseTracking?: boolean;
  mouseMode?: TerminalMouseMode;
  sgrMouse?: boolean;
  sgrPixelsMouse?: boolean;
  focusReporting?: boolean;
  win32InputMode?: boolean;
  kittyKeyboardFlags?: number;
  scrollbackOffset?: number;
  cursor: CursorSnapshot;
  dirtyRows: RowSnapshot[];
  full: boolean;
  title?: string | null;
  clipboardWrite?: string | null;
}

export type TerminalSnapshotPollResponse =
  | { kind: 'unchanged'; seq: number; exited?: boolean; exitCode?: number | null }
  | { kind: 'snapshot'; snapshot: RenderSnapshot; exited?: boolean; exitCode?: number | null };

export interface TerminalCanvasSurfaceProps {
  sessionId: string;
  workspaceId?: string | null;
  className?: string;
  isFocused?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  onTitleChange?: (title: string) => void;
  onProcessExit?: (exitCode: number | null) => void;
}

export interface SelectionPoint {
  col: number;
  row: number;
}

export interface HoveredLinkSpan {
  row: number;
  startCol: number;
  endCol: number;
  kind: 'web' | 'file';
  text: string;
}

export const DEFAULT_BG_HEX = '#0a0a0a';
export const DEFAULT_FG_HEX = '#fafafa';
export const SELECTION_BG = 'rgba(92, 143, 255, 0.32)';
export const PAD_X = 12;
export const PAD_Y = 8;

export interface TerminalCanvasGridMetrics {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  baselineOffset: number;
}

let sharedMeasureCanvas: HTMLCanvasElement | null = null;

export function isPrivateUseNerdIcon(cp: number): boolean {
  return (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0x10fffd);
}

export function isWordChar(ch: string): boolean {
  if (!ch || ch === ' ') return false;
  return !/[\s"'`()[\]{}<>,.;:|\\/?!@#$%^&*=+~]/.test(ch);
}

export function measureTerminalCanvasGrid(
  containerEl: HTMLElement | null,
  prefsInput?: TerminalAppearancePrefs
): TerminalCanvasGridMetrics {
  const prefs = prefsInput ?? getTerminalAppearancePrefs();
  const fontFamily = resolveTerminalFontFamily(prefs.fontFamilyId);
  const fontSize = prefs.fontSize;
  const lineHeight = prefs.lineHeight;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  let cellW = fontSize * 0.6;
  const cellH = Math.max(12, Math.round(fontSize * lineHeight * dpr) / dpr);
  let baselineOffset = Math.round(cellH * 0.78);

  if (typeof document !== 'undefined') {
    if (!sharedMeasureCanvas) {
      sharedMeasureCanvas = document.createElement('canvas');
    }
    const ctx = sharedMeasureCanvas.getContext('2d');
    if (ctx) {
      ctx.font = `${fontSize}px ${fontFamily}`;
      const sample = 'MMMMMMMMMMMMMMMM';
      const measuredW = ctx.measureText(sample).width / sample.length;
      if (Number.isFinite(measuredW) && measuredW > 2) {
        cellW = measuredW;
      }
      const m = ctx.measureText('M');
      const ascent =
        (m as TextMetrics & { fontBoundingBoxAscent?: number }).fontBoundingBoxAscent ??
        m.actualBoundingBoxAscent ??
        fontSize * 0.8;
      const descent =
        (m as TextMetrics & { fontBoundingBoxDescent?: number }).fontBoundingBoxDescent ??
        m.actualBoundingBoxDescent ??
        fontSize * 0.2;
      if (ascent + descent > 0) {
        baselineOffset = (cellH + ascent - descent) * 0.5;
      }
    }
  }

  if (!containerEl) {
    return { cols: 80, rows: 24, cellW, cellH, baselineOffset };
  }

  const rect = containerEl.getBoundingClientRect();
  if (rect.width < 120 || rect.height < 60) {
    return { cols: 80, rows: 24, cellW, cellH, baselineOffset };
  }

  const innerW = Math.max(0, rect.width - PAD_X * 2);
  const innerH = Math.max(0, rect.height - PAD_Y * 2);
  const cols = Math.max(20, Math.floor(innerW / cellW));
  const rows = Math.max(5, Math.floor(innerH / cellH));

  return { cols, rows, cellW, cellH, baselineOffset };
}
