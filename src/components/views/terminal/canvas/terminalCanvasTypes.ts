import { resolveTerminalFontFamily, getTerminalAppearancePrefs, type TerminalAppearancePrefs } from '../../../../lib/terminalAppearancePrefs';
import {
  getActivePaletteForState,
  getThemePackById,
  readThemeCustomizations,
  resolveEffectiveBackdropPreset,
  resolveThemeMode,
  type KiteThemeCustomizations,
  type ResolvedThemeMode,
} from '../../../../lib/themeCustomizations';

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

/**
 * Inclusive visible viewport row indexes covered by a buffer-relative selection
 * (`relRow = viewportRow - scrollbackOffset`). Empty when either end is missing
 * or the selection lies completely outside the visible viewport.
 */
export function selectionRows(
  start: SelectionPoint | null,
  end: SelectionPoint | null,
  scrollbackOffset = 0,
  gridRows?: number,
): number[] {
  if (!start || !end) return [];
  let from = Math.min(start.row, end.row) + scrollbackOffset;
  let to = Math.max(start.row, end.row) + scrollbackOffset;
  if (gridRows !== undefined) {
    if (to < 0 || from >= gridRows) return [];
    from = Math.max(0, from);
    to = Math.min(gridRows - 1, to);
  } else {
    if (to < 0) return [];
    from = Math.max(0, from);
  }
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

const RUST_ANSI_BASE: readonly [number, number, number][] = [
  [23, 23, 23],
  [224, 108, 117],
  [127, 217, 154],
  [232, 200, 122],
  [92, 143, 255],
  [212, 160, 140],
  [94, 200, 197],
  [212, 212, 212],
  [118, 124, 138],
  [255, 138, 138],
  [168, 240, 184],
  [255, 224, 138],
  [138, 176, 255],
  [232, 196, 176],
  [138, 232, 228],
  [250, 250, 250],
];

export interface TerminalCanvasThemeColors {
  mode: ResolvedThemeMode;
  paletteId: string;
  transparentBg: boolean;
  bg: string;
  fg: string;
  cursor: string;
  selection: string;
  bgRgb: [number, number, number];
  fgRgb: [number, number, number];
  cursorRgb: [number, number, number];
  ansi: readonly string[];
  ansiRgb: readonly [number, number, number][];
  colorRemap: Map<number, [number, number, number]>;
}

export function parseCssHexToRgb(
  color: string,
  fallback: [number, number, number]
): [number, number, number] {
  const trimmed = color.trim();
  const shortHex = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
  if (shortHex) {
    const h = shortHex[1];
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16),
    ];
  }
  const fullHex = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(trimmed);
  if (fullHex) {
    const h = fullHex[1];
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(trimmed);
  if (rgbMatch) {
    return [
      Math.min(255, Math.max(0, Number(rgbMatch[1]))),
      Math.min(255, Math.max(0, Number(rgbMatch[2]))),
      Math.min(255, Math.max(0, Number(rgbMatch[3]))),
    ];
  }
  return fallback;
}

function rgbKey(rgb: readonly [number, number, number]): number {
  return ((rgb[0] & 0xff) << 16) | ((rgb[1] & 0xff) << 8) | (rgb[2] & 0xff);
}

export function resolveTerminalCanvasTheme(
  customizationsInput?: KiteThemeCustomizations
): TerminalCanvasThemeColors {
  const state = customizationsInput ?? readThemeCustomizations();
  const mode = resolveThemeMode(state.appearanceMode);
  const paletteId = getActivePaletteForState(state, mode);
  const pack = getThemePackById(paletteId);
  const effectiveBackdrop = resolveEffectiveBackdropPreset(state, pack);
  const transparentBg = state.surface.translucent || effectiveBackdrop !== 'none';

  const bg = state.overrides.surface ?? pack.tokens.terminalBg;
  const fg = state.overrides.ink ?? pack.tokens.terminalFg;
  const cursor = state.overrides.accent ?? pack.tokens.terminalCursor;
  const bgRgb = parseCssHexToRgb(bg, mode === 'light' ? [248, 250, 252] : [10, 10, 10]);
  const fgRgb = parseCssHexToRgb(fg, mode === 'light' ? [15, 23, 42] : [250, 250, 250]);
  const cursorRgb = parseCssHexToRgb(cursor, [92, 143, 255]);

  const selection = state.overrides.accent
    ? `rgba(${cursorRgb[0]}, ${cursorRgb[1]}, ${cursorRgb[2]}, ${mode === 'light' ? 0.22 : 0.30})`
    : pack.tokens.terminalSelection;

  const ansiRgb = pack.tokens.ansi.map((hex, index) =>
    parseCssHexToRgb(hex, RUST_ANSI_BASE[index] ?? fgRgb)
  );

  const colorRemap = new Map<number, [number, number, number]>();
  for (let i = 0; i < RUST_ANSI_BASE.length; i += 1) {
    colorRemap.set(rgbKey(RUST_ANSI_BASE[i]), ansiRgb[i] ?? fgRgb);
  }
  // Map Rust DEFAULT_FG ([250, 250, 250]) and DEFAULT_BG ([10, 10, 10]) to the active theme
  colorRemap.set(rgbKey([250, 250, 250]), fgRgb);
  colorRemap.set(rgbKey([10, 10, 10]), bgRgb);

  return {
    mode,
    paletteId,
    transparentBg,
    bg,
    fg,
    cursor,
    selection,
    bgRgb,
    fgRgb,
    cursorRgb,
    ansi: pack.tokens.ansi,
    ansiRgb,
    colorRemap,
  };
}

export function remapTerminalCellRgb(
  rgb: readonly [number, number, number],
  theme: TerminalCanvasThemeColors
): readonly [number, number, number] {
  return theme.colorRemap.get(rgbKey(rgb)) ?? rgb;
}

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
