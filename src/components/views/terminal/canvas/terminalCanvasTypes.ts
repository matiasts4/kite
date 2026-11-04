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
  wrapped?: boolean;
}

export interface CursorSnapshot {
  visible: boolean;
  col: number;
  row: number;
  shape: string; // 'bar' | 'block' | 'underline'
  blink?: boolean;
}

export type TerminalMouseMode = 'none' | 'click' | 'drag' | 'any';

/** One dirty row of a packed `SNAPSHOT_BIN` payload, addressed by byte offset. */
export interface PackedDirtyRowView {
  index: number;
  wrapped: boolean;
  cellCount: number;
  /** Byte offset of the first 16-byte BinaryCellRecord for this row inside buffer */
  byteOffset: number;
}

/** One row of a reusable cell grid. `cells` is mutated in place on steady-state frames. */
export interface GridRowState {
  cells: CellSnapshot[];
  wrapped: boolean;
}

/** Reusable cell grid shared between the packed decoder and the canvas renderer. */
export interface GridState {
  cols: number;
  rowCount: number;
  rows: GridRowState[];
}

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
  scrollbackDepth?: number;
  cursor: CursorSnapshot;
  dirtyRows: RowSnapshot[];
  full: boolean;
  title?: string | null;
  clipboardWrite?: string | null;
  /** Backend benchmark gate state carried by the `SNAPSHOT_BIN` metadata tail. */
  benchmarkActive?: boolean;
  /** Raw PTY output observed while the frame was produced (already decoded UTF-8 text). */
  observedText?: string | null;
  /** Raw PTY output observed while the frame was produced (base64-encoded bytes). */
  observedBytesBase64?: string | null;
  /** Underlying packed payload for renderers that paint straight from the buffer. */
  packedBuffer?: ArrayBuffer;
  /** Byte offset of the packed payload inside `packedBuffer`. */
  packedByteOffset?: number;
  /** Dirty rows of the packed payload, in frame order. */
  packedDirtyRows?: PackedDirtyRowView[];
  /** Byte offset of the overflow UTF-8 string table inside the payload view. */
  overflowUtf8Offset?: number;
  /** Byte length of the overflow UTF-8 string table. */
  overflowUtf8Length?: number;
}

export type TerminalSnapshotPollResponse =
  | {
      kind: 'unchanged';
      seq: number;
      exited?: boolean;
      exitCode?: number | null;
      /** Raw PTY bytes drained for the agent registry. Paint still uses the grid. */
      observedBytesBase64?: string;
    }
  | {
      kind: 'snapshot';
      snapshot: RenderSnapshot;
      exited?: boolean;
      exitCode?: number | null;
      observedBytesBase64?: string;
    };

export interface TerminalCanvasSurfaceProps {
  sessionId: string;
  workspaceId?: string | null;
  engine?: string;
  className?: string;
  isFocused?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  onTitleChange?: (title: string) => void;
  onProcessExit?: (exitCode: number | null) => void;
  /** Stages image bytes. Returns false when the blob is not a supported image. */
  onStageClipboardBlob?: (blob: Blob, mimeType: string, fileName?: string) => boolean;
}

export interface TerminalSurfaceHandle {
  clear: () => void;
  fit: () => void;
  focus: () => void;
}

export interface SelectionPoint {
  col: number;
  row: number;
}

/** Inclusive row indexes covered by a selection. Empty when either end is missing. */
export function selectionRows(
  start: SelectionPoint | null,
  end: SelectionPoint | null,
): number[] {
  if (!start || !end) return [];
  const from = Math.min(start.row, end.row);
  const to = Math.max(start.row, end.row);
  const rows: number[] = [];
  for (let row = from; row <= to; row += 1) rows.push(row);
  return rows;
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
