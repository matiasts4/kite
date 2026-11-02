import React, { useEffect, useRef, useCallback, useState } from 'react';
import { invokeCommand } from '../../lib/ipc';
import {
  getTerminalAppearancePrefs,
  resolveTerminalFontFamily,
  TERMINAL_APPEARANCE_CHANGED_EVENT,
  type TerminalAppearancePrefs,
} from '../../lib/terminalAppearancePrefs';
import { isTerminalDividerDragging, onTerminalDividerDragEnd } from '../../lib/terminalViewport';
import { isProceduralSpriteChar, drawProceduralSprite } from '../../lib/terminalSprites';
import { openFileInRightDock } from '../../lib/filePreviewNav';
import {
  extractTerminalLinks,
  getTerminalWebLinksTarget,
  openTerminalWebLink,
} from '../../lib/terminalLinkNav';

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
  onFocus?: () => void;
  onBlur?: () => void;
  onTitleChange?: (title: string) => void;
  onProcessExit?: (exitCode: number | null) => void;
}

interface SelectionPoint {
  col: number;
  row: number;
}

interface HoveredLinkSpan {
  row: number;
  startCol: number;
  endCol: number;
  kind: 'web' | 'file';
  text: string;
}

const DEFAULT_BG_HEX = '#0a0a0a';
const DEFAULT_FG_HEX = '#fafafa';
const SELECTION_BG = 'rgba(92, 143, 255, 0.32)';
const PAD_X = 12;
const PAD_Y = 8;

export interface TerminalCanvasGridMetrics {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  baselineOffset: number;
}

let sharedMeasureCanvas: HTMLCanvasElement | null = null;

function isPrivateUseNerdIcon(cp: number): boolean {
  return (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0x10fffd);
}

function isWordChar(ch: string): boolean {
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

export const TerminalCanvasSurface: React.FC<TerminalCanvasSurfaceProps> = ({
  sessionId,
  workspaceId = null,
  className = '',
  onFocus,
  onBlur,
  onTitleChange,
  onProcessExit,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [prefs, setPrefs] = useState<TerminalAppearancePrefs>(() => getTerminalAppearancePrefs());
  const [pointerCursor, setPointerCursor] = useState<boolean>(false);

  const lastSeqRef = useRef<number>(0);
  const matrixRef = useRef<CellSnapshot[][]>([]);
  const cursorRef = useRef<CursorSnapshot>({
    visible: true,
    col: 0,
    row: 0,
    shape: 'bar',
  });

  // Track grid dimensions measured from DOM vs dimensions applied to the backend PTY
  const gridColsRef = useRef<number>(80);
  const gridRowsRef = useRef<number>(24);
  const appliedPtyColsRef = useRef<number>(0);
  const appliedPtyRowsRef = useRef<number>(0);
  const cachedRectRef = useRef<DOMRect | null>(null);
  const resizeInFlightRef = useRef<boolean>(false);

  // Terminal mode flags from backend VT engine
  const alternateScreenRef = useRef<boolean>(false);
  const applicationCursorRef = useRef<boolean>(false);
  const bracketedPasteRef = useRef<boolean>(false);
  const mouseModeRef = useRef<TerminalMouseMode>('none');
  const sgrMouseRef = useRef<boolean>(false);
  const sgrPixelsMouseRef = useRef<boolean>(false);
  const focusReportingRef = useRef<boolean>(false);
  const win32InputModeRef = useRef<boolean>(false);
  const kittyKeyboardFlagsRef = useRef<number>(0);
  const scrollbackOffsetRef = useRef<number>(0);
  const lastTitleRef = useRef<string>('');
  const hasNotifiedExitRef = useRef<boolean>(false);

  const onProcessExitRef = useRef(onProcessExit);
  onProcessExitRef.current = onProcessExit;
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

  const cellWidthRef = useRef<number>(8);
  const cellHeightRef = useRef<number>(16);
  const baselineOffsetRef = useRef<number>(13);
  const spareYRef = useRef<number>(0);

  const isFocusedRef = useRef<boolean>(false);
  const rafIdRef = useRef<number | null>(null);
  const immediatePollRef = useRef<(() => void) | null>(null);
  const wheelAccumYRef = useRef<number>(0);
  const wheelAccumXRef = useRef<number>(0);
  const fastPollUntilRef = useRef(0);
  const scrollInFlightRef = useRef(false);
  const pendingScrollLinesRef = useRef(0);

  // Mouse tracking state (per-pane button mask & motion deduplication)
  const buttonsDownRef = useRef<number>(0);
  const lastMouseReportRef = useRef<{ col: number; row: number; buttons: number } | null>(null);

  // Selection state (single, word, line + auto-scroll)
  const isSelectingRef = useRef<boolean>(false);
  const selectionModeRef = useRef<'char' | 'word' | 'line'>('char');
  const selectionAnchorRef = useRef<SelectionPoint | null>(null);
  const selectionStartRef = useRef<SelectionPoint | null>(null);
  const selectionEndRef = useRef<SelectionPoint | null>(null);
  const selectionAutoScrollTimerRef = useRef<number | null>(null);
  const lastDragClientYRef = useRef<number | null>(null);
  const lastDragClientXRef = useRef<number | null>(null);

  // Hovered link state (Ctrl+Hover / Ctrl+Click)
  const hoveredLinkRef = useRef<HoveredLinkSpan | null>(null);

  // Reset tracking when sessionId changes
  useEffect(() => {
    lastSeqRef.current = 0;
    matrixRef.current = [];
    appliedPtyColsRef.current = 0;
    appliedPtyRowsRef.current = 0;
    scrollbackOffsetRef.current = 0;
    mouseModeRef.current = 'none';
    sgrMouseRef.current = false;
    sgrPixelsMouseRef.current = false;
    focusReportingRef.current = false;
    win32InputModeRef.current = false;
    kittyKeyboardFlagsRef.current = 0;
    buttonsDownRef.current = 0;
    lastMouseReportRef.current = null;
    hasNotifiedExitRef.current = false;
    selectionAnchorRef.current = null;
    selectionStartRef.current = null;
    selectionEndRef.current = null;
    hoveredLinkRef.current = null;
  }, [sessionId]);

  // Track appearance preferences changes
  useEffect(() => {
    const handlePrefsChange = (e: Event) => {
      const customEvent = e as CustomEvent<TerminalAppearancePrefs>;
      if (customEvent.detail) {
        setPrefs(customEvent.detail);
      } else {
        setPrefs(getTerminalAppearancePrefs());
      }
    };
    window.addEventListener(TERMINAL_APPEARANCE_CHANGED_EVENT, handlePrefsChange);
    return () => {
      window.removeEventListener(TERMINAL_APPEARANCE_CHANGED_EVENT, handlePrefsChange);
    };
  }, []);

  // Main render function
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cached = cachedRectRef.current;
    const rect =
      cached && cached.width >= 4 && cached.height >= 4
        ? cached
        : (cachedRectRef.current = container.getBoundingClientRect());
    if (rect.width < 4 || rect.height < 4) return;

    const dpr = window.devicePixelRatio || 1;
    const displayW = rect.width;
    const displayH = rect.height;
    const targetPixelW = Math.max(1, Math.round(displayW * dpr));
    const targetPixelH = Math.max(1, Math.round(displayH * dpr));

    if (canvas.width !== targetPixelW || canvas.height !== targetPixelH) {
      canvas.width = targetPixelW;
      canvas.height = targetPixelH;
    }

    const snap = (v: number) => Math.round(v * dpr) / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Clear full viewport background
    ctx.fillStyle = DEFAULT_BG_HEX;
    ctx.fillRect(0, 0, displayW, displayH);

    const cellW = cellWidthRef.current;
    const cellH = cellHeightRef.current;
    const baseline = baselineOffsetRef.current;
    const fontFamily = resolveTerminalFontFamily(prefs.fontFamilyId);
    const fontSize = prefs.fontSize;
    const normalFont = `${fontSize}px ${fontFamily}`;
    const boldFont = `bold ${fontSize}px ${fontFamily}`;
    const italicFont = `italic ${fontSize}px ${fontFamily}`;
    const boldItalicFont = `bold italic ${fontSize}px ${fontFamily}`;

    const matrix = matrixRef.current;
    const cursor = cursorRef.current;
    const visibleRows = Math.min(matrix.length, gridRowsRef.current);
    const visibleCols = gridColsRef.current;

    const innerH = Math.max(0, displayH - PAD_Y * 2);
    const spareY = Math.max(0, innerH - gridRowsRef.current * cellH);
    const ox = PAD_X;
    const oy = PAD_Y + snap(spareY * 0.5);
    spareYRef.current = snap(spareY * 0.5);

    // Selection range normalization
    let selStart = selectionStartRef.current;
    let selEnd = selectionEndRef.current;
    let hasSelection = false;
    if (selStart && selEnd && (selStart.row !== selEnd.row || selStart.col !== selEnd.col)) {
      if (selStart.row > selEnd.row || (selStart.row === selEnd.row && selStart.col > selEnd.col)) {
        const tmp = selStart;
        selStart = selEnd;
        selEnd = tmp;
      }
      hasSelection = true;
    }

    // Pass 1: Batched cell backgrounds & selection highlights
    for (let r = 0; r < visibleRows; r++) {
      const row = matrix[r];
      if (!row) continue;
      const y0 = snap(oy + r * cellH);
      const y1 = snap(oy + (r + 1) * cellH);
      const rh = y1 - y0;
      const maxCol = Math.min(row.length, visibleCols);

      let c = 0;
      while (c < maxCol) {
        const cell = row[c];
        if (!cell || cell.width === 0 || !cell.hasBg) {
          c++;
          continue;
        }
        const [br, bg, bb] = cell.bg;
        let endCol = c + Math.max(1, cell.width);
        while (endCol < maxCol) {
          const next = row[endCol];
          if (!next) break;
          if (next.width === 0) {
            endCol++;
            continue;
          }
          if (
            next.hasBg &&
            next.bg[0] === br &&
            next.bg[1] === bg &&
            next.bg[2] === bb
          ) {
            endCol += Math.max(1, next.width);
          } else {
            break;
          }
        }
        const x0 = snap(ox + c * cellW);
        const x1 = snap(ox + endCol * cellW);
        ctx.fillStyle = `rgb(${br},${bg},${bb})`;
        ctx.fillRect(x0, y0, x1 - x0, rh);
        c = endCol;
      }

      if (hasSelection && selStart && selEnd && r >= selStart.row && r <= selEnd.row) {
        const startC = Math.max(0, r === selStart.row ? selStart.col : 0);
        const endC = Math.min(visibleCols, r === selEnd.row ? selEnd.col : visibleCols);
        if (endC > startC) {
          const sx0 = snap(ox + startC * cellW);
          const sx1 = snap(ox + endC * cellW);
          ctx.fillStyle = SELECTION_BG;
          ctx.fillRect(sx0, y0, sx1 - sx0, rh);
        }
      }
    }

    // Pass 2: Procedural sprites, batched ASCII runs, Nerd Font icon fitting, non-ASCII glyphs & underlines
    let currentFont = '';
    let currentFill = '';

    for (let r = 0; r < visibleRows; r++) {
      const row = matrix[r];
      if (!row) continue;
      const py = oy + r * cellH;
      const textY = py + baseline;
      const maxCol = Math.min(row.length, visibleCols);

      let c = 0;
      while (c < maxCol) {
        const cell = row[c];
        if (!cell || cell.width === 0) {
          c++;
          continue;
        }

        const ch = cell.ch;
        const cp = ch ? ch.codePointAt(0) ?? 32 : 32;

        // Underline decoration
        if (cell.underline) {
          const fgCss = `rgb(${cell.fg[0]},${cell.fg[1]},${cell.fg[2]})`;
          if (currentFill !== fgCss) {
            ctx.fillStyle = fgCss;
            currentFill = fgCss;
          }
          const ux0 = snap(ox + c * cellW);
          const ux1 = snap(ox + (c + Math.max(1, cell.width)) * cellW);
          ctx.fillRect(ux0, snap(py + cellH - 2), ux1 - ux0, 1);
        }

        if (!ch || ch === ' ') {
          c++;
          continue;
        }

        const fgCss = `rgb(${cell.fg[0]},${cell.fg[1]},${cell.fg[2]})`;

        // Procedural sprite (Box Drawing, Block Elements, Braille, Powerline, Legacy computing)
        if (isProceduralSpriteChar(cp)) {
          if (cell.dim) ctx.globalAlpha = 0.6;
          drawProceduralSprite(
            ctx,
            cp,
            ox + c * cellW,
            py,
            cellW * Math.max(1, cell.width),
            cellH,
            fgCss,
            dpr,
            cell.bold
          );
          if (cell.dim) ctx.globalAlpha = 1;
          currentFill = '';
          c++;
          continue;
        }

        const targetFont = cell.bold
          ? cell.italic
            ? boldItalicFont
            : boldFont
          : cell.italic
            ? italicFont
            : normalFont;

        if (currentFont !== targetFont) {
          ctx.font = targetFont;
          currentFont = targetFont;
        }
        if (currentFill !== fgCss) {
          ctx.fillStyle = fgCss;
          currentFill = fgCss;
        }

        const isBatchableAscii = cp >= 0x20 && cp <= 0x7e && cell.width === 1;
        if (isBatchableAscii) {
          let runText = ch;
          let nextC = c + 1;
          while (nextC < maxCol) {
            const nextCell = row[nextC];
            if (!nextCell || nextCell.width !== 1) break;
            const nextCh = nextCell.ch || ' ';
            const nextCp = nextCh.codePointAt(0) ?? 32;
            if (
              nextCp < 0x20 ||
              nextCp > 0x7e ||
              nextCell.bold !== cell.bold ||
              nextCell.italic !== cell.italic ||
              nextCell.dim !== cell.dim ||
              nextCell.fg[0] !== cell.fg[0] ||
              nextCell.fg[1] !== cell.fg[1] ||
              nextCell.fg[2] !== cell.fg[2]
            ) {
              break;
            }
            if (nextCell.underline) {
              const ux0 = snap(ox + nextC * cellW);
              const ux1 = snap(ox + (nextC + 1) * cellW);
              ctx.fillRect(ux0, snap(py + cellH - 2), ux1 - ux0, 1);
            }
            runText += nextCh;
            nextC++;
          }
          if (cell.dim) ctx.globalAlpha = 0.6;
          ctx.fillText(runText, ox + c * cellW, textY);
          if (cell.dim) ctx.globalAlpha = 1;
          c = nextC;
        } else if (isPrivateUseNerdIcon(cp)) {
          // Nerd Font PUA icon fitting: allow 1.5 cells when followed by a blank cell,
          // scaling down proportionally if the icon glyph exceeds available space.
          const nextIsBlank =
            c + 1 < maxCol && (!row[c + 1] || !row[c + 1].ch || row[c + 1].ch === ' ');
          const availCells = nextIsBlank ? 1.45 : 1.0;
          const availW = availCells * cellW;
          const glyphW = ctx.measureText(ch).width;
          if (cell.dim) ctx.globalAlpha = 0.6;
          if (glyphW > availW && glyphW > 1) {
            const scale = availW / glyphW;
            ctx.save();
            ctx.translate(ox + c * cellW, textY);
            ctx.scale(scale, scale);
            ctx.fillText(ch, 0, 0);
            ctx.restore();
            currentFont = '';
            currentFill = '';
          } else {
            const offsetX = Math.max(0, (cellW - glyphW) * 0.5);
            ctx.fillText(ch, ox + c * cellW + offsetX, textY);
          }
          if (cell.dim) ctx.globalAlpha = 1;
          c++;
        } else {
          // Non-ASCII / wide char: position individually so font fallback never shifts subsequent columns
          if (cell.dim) ctx.globalAlpha = 0.6;
          ctx.fillText(ch, ox + c * cellW, textY);
          if (cell.dim) ctx.globalAlpha = 1;
          c++;
        }
      }
    }

    // Pass 2.5: Hovered Ctrl+Click link underline
    const hoveredLink = hoveredLinkRef.current;
    if (hoveredLink && hoveredLink.row >= 0 && hoveredLink.row < visibleRows) {
      const ly = snap(oy + (hoveredLink.row + 1) * cellH - 2);
      const lx0 = snap(ox + hoveredLink.startCol * cellW);
      const lx1 = snap(ox + hoveredLink.endCol * cellW);
      ctx.fillStyle = '#5c8fff';
      ctx.fillRect(lx0, ly, Math.max(2, lx1 - lx0), 1.5);
    }

    // Pass 3: Cursor
    if (
      cursor.visible &&
      scrollbackOffsetRef.current === 0 &&
      cursor.row >= 0 &&
      cursor.row < visibleRows &&
      cursor.col >= 0 &&
      cursor.col < visibleCols
    ) {
      const curCell = matrix[cursor.row]?.[cursor.col];
      const curSpan = curCell && curCell.width > 1 ? curCell.width : 1;
      const cx = snap(ox + cursor.col * cellW);
      const cy = snap(oy + cursor.row * cellH);
      const cw = snap(ox + (cursor.col + curSpan) * cellW) - cx;
      const ch = snap(oy + (cursor.row + 1) * cellH) - cy;

      if (!isFocusedRef.current) {
        ctx.strokeStyle = 'rgba(250, 250, 250, 0.45)';
        ctx.lineWidth = 1;
        ctx.strokeRect(cx + 0.5, cy + 0.5, Math.max(1, cw - 1), Math.max(1, ch - 1));
      } else {
        const shape = cursor.shape || prefs.cursorStyle || 'bar';
        ctx.fillStyle = DEFAULT_FG_HEX;
        if (shape === 'bar') {
          ctx.fillRect(cx, cy, Math.max(2, Math.round(2 * dpr) / dpr), ch);
        } else if (shape === 'underline') {
          ctx.fillRect(cx, cy + ch - 2, cw, 2);
        } else {
          // Solid block cursor with inverted character on top
          ctx.fillRect(cx, cy, cw, ch);
          if (curCell && curCell.ch && curCell.ch !== ' ') {
            ctx.fillStyle = DEFAULT_BG_HEX;
            ctx.font = curCell.bold ? boldFont : normalFont;
            ctx.fillText(curCell.ch, ox + cursor.col * cellW, oy + cursor.row * cellH + baseline);
          }
        }
      }
    }

    // Pass 4: Scrollback indicator pill when scrolled up
    if (scrollbackOffsetRef.current > 0) {
      const label = `↑ ${scrollbackOffsetRef.current} lines`;
      ctx.font = `11px ${fontFamily}`;
      const badgeW = Math.ceil(ctx.measureText(label).width) + 14;
      const badgeH = 20;
      const bx = displayW - badgeW - 10;
      const by = 8;
      ctx.fillStyle = 'rgba(24, 24, 28, 0.88)';
      ctx.fillRect(bx, by, badgeW, badgeH);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, badgeW - 1, badgeH - 1);
      ctx.fillStyle = '#e8c87a';
      ctx.fillText(label, bx + 7, by + 14);
    }

    ctx.restore();
  }, [prefs]);

  const scheduleRender = useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = window.requestAnimationFrame(() => {
      rafIdRef.current = null;
      renderCanvas();
    });
  }, [renderCanvas]);

  const armFastPoll = useCallback((ms: number) => {
    fastPollUntilRef.current = performance.now() + ms;
  }, []);

  const applySnapshot = useCallback((snapshot: RenderSnapshot) => {
    lastSeqRef.current = snapshot.seq;
    cursorRef.current = snapshot.cursor;
    alternateScreenRef.current = Boolean(snapshot.alternateScreen);
    applicationCursorRef.current = Boolean(snapshot.applicationCursor);
    bracketedPasteRef.current = Boolean(snapshot.bracketedPaste);
    mouseModeRef.current = snapshot.mouseMode ?? (snapshot.mouseTracking ? 'click' : 'none');
    sgrMouseRef.current = Boolean(snapshot.sgrMouse);
    sgrPixelsMouseRef.current = Boolean(snapshot.sgrPixelsMouse);
    focusReportingRef.current = Boolean(snapshot.focusReporting);
    win32InputModeRef.current = Boolean(snapshot.win32InputMode);
    kittyKeyboardFlagsRef.current = snapshot.kittyKeyboardFlags ?? 0;
    scrollbackOffsetRef.current = snapshot.scrollbackOffset ?? 0;

    if (snapshot.title && snapshot.title !== lastTitleRef.current) {
      lastTitleRef.current = snapshot.title;
      onTitleChangeRef.current?.(snapshot.title);
    }

    if (
      snapshot.clipboardWrite &&
      typeof navigator !== 'undefined' &&
      navigator.clipboard?.writeText
    ) {
      void navigator.clipboard.writeText(snapshot.clipboardWrite).catch(() => {});
    }

    if (snapshot.full) {
      const newMatrix: CellSnapshot[][] = Array.from({ length: snapshot.rows }, () => []);
      for (const row of snapshot.dirtyRows) {
        if (row.rowIdx >= 0 && row.rowIdx < newMatrix.length) {
          newMatrix[row.rowIdx] = row.cells;
        }
      }
      matrixRef.current = newMatrix;
    } else {
      if (matrixRef.current.length !== snapshot.rows) {
        matrixRef.current.length = snapshot.rows;
      }
      for (const row of snapshot.dirtyRows) {
        matrixRef.current[row.rowIdx] = row.cells;
      }
    }

    if (
      appliedPtyColsRef.current > 0 &&
      !resizeInFlightRef.current &&
      (snapshot.cols !== appliedPtyColsRef.current ||
        snapshot.rows !== appliedPtyRowsRef.current) &&
      !isTerminalDividerDragging()
    ) {
      resizeInFlightRef.current = true;
      armFastPoll(350);
      void invokeCommand('resize_terminal', {
        sessionId,
        columns: appliedPtyColsRef.current,
        rows: appliedPtyRowsRef.current,
      })
        .catch(() => {})
        .finally(() => {
          resizeInFlightRef.current = false;
          immediatePollRef.current?.();
        });
    }

    scheduleRender();
  }, [armFastPoll, scheduleRender, sessionId]);

  const requestScrollLines = useCallback((lines: number) => {
    if (!lines) return;
    pendingScrollLinesRef.current += lines;
    const flush = () => {
      const delta = pendingScrollLinesRef.current;
      if (!delta) {
        scrollInFlightRef.current = false;
        return;
      }
      pendingScrollLinesRef.current = 0;
      scrollInFlightRef.current = true;
      void invokeCommand<RenderSnapshot>('scroll_terminal_viewport', {
        sessionId,
        deltaLines: delta,
      })
        .then((snapshot) => {
          if (snapshot && typeof snapshot.seq === 'number') {
            applySnapshot(snapshot);
          }
          scheduleRender();
        })
        .catch(() => {})
        .finally(() => {
          if (pendingScrollLinesRef.current !== 0) flush();
          else scrollInFlightRef.current = false;
        });
    };
    if (scrollInFlightRef.current) return;
    flush();
  }, [applySnapshot, scheduleRender, sessionId]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      if (selectionAutoScrollTimerRef.current !== null) {
        window.clearInterval(selectionAutoScrollTimerRef.current);
        selectionAutoScrollTimerRef.current = null;
      }
    };
  }, []);

  // Measure container & synchronize PTY size
  const syncGridAndResizePty = useCallback(
    (forceImmediate = false) => {
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      cachedRectRef.current = rect;
      if (rect.width < 120 || rect.height < 60) return;

      const metrics = measureTerminalCanvasGrid(container, prefs);
      cellWidthRef.current = metrics.cellW;
      cellHeightRef.current = metrics.cellH;
      baselineOffsetRef.current = metrics.baselineOffset;
      gridColsRef.current = metrics.cols;
      gridRowsRef.current = metrics.rows;

      scheduleRender();

      // Do not send PTY resize IPC while the user is actively dragging a split divider
      if (isTerminalDividerDragging() && !forceImmediate) {
        return;
      }

      if (
        !forceImmediate &&
        metrics.cols === appliedPtyColsRef.current &&
        metrics.rows === appliedPtyRowsRef.current
      ) {
        return;
      }

      appliedPtyColsRef.current = metrics.cols;
      appliedPtyRowsRef.current = metrics.rows;
      resizeInFlightRef.current = true;
      fastPollUntilRef.current = performance.now() + 350;

      void invokeCommand('resize_terminal', {
        sessionId,
        columns: metrics.cols,
        rows: metrics.rows,
      })
        .catch(() => {})
        .finally(() => {
          resizeInFlightRef.current = false;
          immediatePollRef.current?.();
        });
    },
    [sessionId, prefs, scheduleRender]
  );

  // Re-measure & sync PTY whenever appearance prefs or sessionId change
  useEffect(() => {
    syncGridAndResizePty(false);
  }, [syncGridAndResizePty]);

  // Handle ResizeObserver & Split Divider Drag End
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let resizeTimer: number | null = null;

    const onContainerResize = () => {
      const rect = container.getBoundingClientRect();
      cachedRectRef.current = rect;
      if (rect.width < 120 || rect.height < 60) return;

      const metrics = measureTerminalCanvasGrid(container, prefs);
      cellWidthRef.current = metrics.cellW;
      cellHeightRef.current = metrics.cellH;
      baselineOffsetRef.current = metrics.baselineOffset;
      gridColsRef.current = metrics.cols;
      gridRowsRef.current = metrics.rows;
      scheduleRender();

      if (isTerminalDividerDragging()) {
        return;
      }

      if (
        metrics.cols === appliedPtyColsRef.current &&
        metrics.rows === appliedPtyRowsRef.current
      ) {
        return;
      }

      if (resizeTimer !== null) {
        window.clearTimeout(resizeTimer);
      }

      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        if (isTerminalDividerDragging()) return;
        const latestRect = container.getBoundingClientRect();
        cachedRectRef.current = latestRect;
        if (latestRect.width < 120 || latestRect.height < 60) return;
        const latest = measureTerminalCanvasGrid(container, prefs);
        gridColsRef.current = latest.cols;
        gridRowsRef.current = latest.rows;
        if (
          latest.cols === appliedPtyColsRef.current &&
          latest.rows === appliedPtyRowsRef.current
        ) {
          return;
        }
        appliedPtyColsRef.current = latest.cols;
        appliedPtyRowsRef.current = latest.rows;
        resizeInFlightRef.current = true;
        fastPollUntilRef.current = performance.now() + 350;
        void invokeCommand('resize_terminal', {
          sessionId,
          columns: latest.cols,
          rows: latest.rows,
        })
          .catch(() => {})
          .finally(() => {
            resizeInFlightRef.current = false;
            immediatePollRef.current?.();
          });
      }, 32);
    };

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        onContainerResize();
      });
      ro.observe(container);
    }

    const unbindDragEnd = onTerminalDividerDragEnd(() => {
      if (resizeTimer !== null) {
        window.clearTimeout(resizeTimer);
        resizeTimer = null;
      }
      syncGridAndResizePty(true);
    });

    const handleDprOrWindowResize = () => {
      onContainerResize();
    };
    window.addEventListener('resize', handleDprOrWindowResize);

    return () => {
      ro?.disconnect();
      unbindDragEnd();
      window.removeEventListener('resize', handleDprOrWindowResize);
      if (resizeTimer !== null) {
        window.clearTimeout(resizeTimer);
      }
    };
  }, [sessionId, prefs, scheduleRender, syncGridAndResizePty]);

  // Polling loop from Rust backend
  useEffect(() => {
    let active = true;
    let pollTimer: number | null = null;
    let inFlight = false;
    fastPollUntilRef.current = performance.now() + 500;

    const poll = async () => {
      if (!active || inFlight) return;
      inFlight = true;

      try {
        const res = await invokeCommand<TerminalSnapshotPollResponse>('poll_terminal_snapshot', {
          sessionId,
          sinceSeq: lastSeqRef.current,
        });

        inFlight = false;
        if (!active) return;

        let nextDelay = 120;
        const hidden = typeof document !== 'undefined' && document.hidden;

        if (res) {
          if (res.exited && !hasNotifiedExitRef.current) {
            hasNotifiedExitRef.current = true;
            onProcessExitRef.current?.(res.exitCode ?? null);
          }

          if (res.kind === 'snapshot') {
            applySnapshot(res.snapshot);
            nextDelay = 8;
          } else if (hidden) {
            nextDelay = 500;
          } else if (performance.now() < fastPollUntilRef.current) {
            nextDelay = 10;
          } else {
            nextDelay = 120;
          }
        }

        if (active) {
          pollTimer = window.setTimeout(poll, nextDelay);
        }
      } catch {
        inFlight = false;
        if (active) {
          pollTimer = window.setTimeout(poll, 250);
        }
      }
    };

    const triggerImmediatePoll = () => {
      if (!active) return;
      if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
        pollTimer = null;
      }
      void poll();
    };

    immediatePollRef.current = triggerImmediatePoll;
    void poll();

    window.addEventListener('focus', triggerImmediatePoll);

    return () => {
      active = false;
      immediatePollRef.current = null;
      if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
      }
      window.removeEventListener('focus', triggerImmediatePoll);
    };
  }, [sessionId, applySnapshot]);

  // Send raw input bytes to PTY
  const sendInput = useCallback(
    (data: string, clearSelection = true) => {
      if (!data) return;
      fastPollUntilRef.current = performance.now() + 250;
      void invokeCommand('write_terminal', {
        sessionId,
        input: data,
      }).then(() => {
        immediatePollRef.current?.();
      });
      if (clearSelection && (selectionStartRef.current || selectionEndRef.current)) {
        selectionStartRef.current = null;
        selectionEndRef.current = null;
        scheduleRender();
      }
    },
    [sessionId, scheduleRender]
  );

  const copySelectionToClipboard = useCallback((): boolean => {
    let selStart = selectionStartRef.current;
    let selEnd = selectionEndRef.current;
    if (!selStart || !selEnd) return false;
    if (selStart.row === selEnd.row && selStart.col === selEnd.col) return false;

    if (selStart.row > selEnd.row || (selStart.row === selEnd.row && selStart.col > selEnd.col)) {
      const tmp = selStart;
      selStart = selEnd;
      selEnd = tmp;
    }

    const lines: string[] = [];
    const matrix = matrixRef.current;

    for (let r = selStart.row; r <= selEnd.row; r++) {
      const row = matrix[r];
      if (!row) continue;
      const startC = r === selStart.row ? selStart.col : 0;
      const endC = r === selEnd.row ? selEnd.col : row.length;
      let line = '';
      for (let c = startC; c < endC && c < row.length; c++) {
        const cell = row[c];
        if (!cell || cell.width === 0) continue;
        line += cell.ch || ' ';
      }
      lines.push(line.replace(/\s+$/, ''));
    }

    const text = lines.join('\n');
    if (text && typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text);
      return true;
    }
    return false;
  }, []);

  const pasteTextToTerminal = useCallback(
    (text: string) => {
      if (!text) return;
      const normalized = text.replace(/\r?\n/g, '\r');
      if (bracketedPasteRef.current) {
        sendInput(`\x1b[200~${normalized}\x1b[201~`);
      } else {
        sendInput(normalized);
      }
    },
    [sendInput]
  );

  // Encode modified Enter / Escape under ConPTY win32-input-mode (?9001h)
  const encodeWin32SpecialKey = (
    key: 'Enter' | 'Escape',
    shift: boolean,
    alt: boolean,
    ctrl: boolean
  ): string => {
    const held = (shift ? 0x10 : 0) | (alt ? 0x02 : 0) | (ctrl ? 0x08 : 0);
    if (key === 'Enter') {
      const typed = ctrl && !alt ? 10 : 13;
      return `\x1b[13;28;${typed};1;${held};1_\x1b[13;28;${typed};0;${held};1_`;
    }
    return `\x1b[27;1;27;1;${held};1_\x1b[27;1;27;0;${held};1_`;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    fastPollUntilRef.current = performance.now() + 250;

    const hasMod = e.shiftKey || e.altKey || e.ctrlKey || e.metaKey;
    const modParam =
      1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + ((e.ctrlKey || e.metaKey) ? 4 : 0);
    const kittyFlags = kittyKeyboardFlagsRef.current;
    const win32Mode = win32InputModeRef.current;

    // Ctrl / Cmd + C / V clipboard shortcuts take top priority
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === 'c') {
        if (e.shiftKey || copySelectionToClipboard()) {
          selectionStartRef.current = null;
          selectionEndRef.current = null;
          scheduleRender();
          e.preventDefault();
          return;
        }
        if (!e.metaKey) {
          sendInput('\x03');
          e.preventDefault();
          return;
        }
      }
      if (key === 'v') {
        if (e.shiftKey && typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
          e.preventDefault();
          void navigator.clipboard.readText().then((txt) => {
            if (txt) pasteTextToTerminal(txt);
          });
          return;
        }
        // Standard Ctrl+V is handled by native onPaste
        return;
      }
    }

    // Modified Enter / Escape under Kitty Keyboard Protocol or Win32 Input Mode (?9001h)
    if (e.key === 'Enter' && hasMod) {
      if (kittyFlags > 0) {
        sendInput(`\x1b[13;${modParam}u`);
      } else if (win32Mode) {
        sendInput(encodeWin32SpecialKey('Enter', e.shiftKey, e.altKey, e.ctrlKey));
      } else if (e.altKey && !e.ctrlKey && !e.metaKey) {
        sendInput('\x1b\r');
      } else {
        sendInput('\n');
      }
      e.preventDefault();
      return;
    }

    if (e.key === 'Escape' && hasMod) {
      if (kittyFlags > 0) {
        sendInput(`\x1b[27;${modParam}u`);
      } else if (win32Mode) {
        sendInput(encodeWin32SpecialKey('Escape', e.shiftKey, e.altKey, e.ctrlKey));
      } else {
        sendInput('\x1b');
      }
      e.preventDefault();
      return;
    }

    // Shift + Tab -> Backtab (\x1b[Z) or CSI-u
    if (e.key === 'Tab' && e.shiftKey) {
      sendInput('\x1b[Z');
      e.preventDefault();
      return;
    }

    // Ctrl + Backspace -> delete word backward (\x17) or CSI-u
    if (e.key === 'Backspace' && (e.ctrlKey || e.altKey)) {
      if (kittyFlags > 0) {
        sendInput(`\x1b[127;${modParam}u`);
      } else if (e.altKey && !e.ctrlKey) {
        sendInput('\x1b\x7f');
      } else {
        sendInput('\x17');
      }
      e.preventDefault();
      return;
    }

    // Standard Ctrl + a..z control codes (or Kitty CSI-u when kittyFlags > 0)
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
      const lower = e.key.toLowerCase();
      if (lower >= 'a' && lower <= 'z') {
        if (kittyFlags > 0 && e.shiftKey) {
          sendInput(`\x1b[${lower.charCodeAt(0)};${modParam}u`);
        } else {
          const asciiCode = lower.charCodeAt(0) - 96;
          sendInput(String.fromCharCode(asciiCode));
        }
        e.preventDefault();
        return;
      }
    }

    const arrowLetter: Record<string, string> = {
      ArrowUp: 'A',
      ArrowDown: 'B',
      ArrowRight: 'C',
      ArrowLeft: 'D',
    };

    if (arrowLetter[e.key]) {
      const dir = arrowLetter[e.key];
      if (modParam > 1) {
        sendInput(`\x1b[1;${modParam}${dir}`);
      } else if (applicationCursorRef.current) {
        sendInput(`\x1bO${dir}`);
      } else {
        sendInput(`\x1b[${dir}`);
      }
      e.preventDefault();
      return;
    }

    // Special navigation and control keys
    switch (e.key) {
      case 'Enter':
        sendInput('\r');
        e.preventDefault();
        break;
      case 'Backspace':
        sendInput('\x7f');
        e.preventDefault();
        break;
      case 'Tab':
        sendInput('\t');
        e.preventDefault();
        break;
      case 'Escape':
        sendInput(kittyFlags > 0 ? '\x1b[27u' : '\x1b');
        e.preventDefault();
        break;
      case 'Home':
        sendInput(
          modParam > 1
            ? `\x1b[1;${modParam}H`
            : applicationCursorRef.current
              ? '\x1bOH'
              : '\x1b[H'
        );
        e.preventDefault();
        break;
      case 'End':
        sendInput(
          modParam > 1
            ? `\x1b[1;${modParam}F`
            : applicationCursorRef.current
              ? '\x1bOF'
              : '\x1b[F'
        );
        e.preventDefault();
        break;
      case 'Insert':
        sendInput(modParam > 1 ? `\x1b[2;${modParam}~` : '\x1b[2~');
        e.preventDefault();
        break;
      case 'Delete':
        sendInput(modParam > 1 ? `\x1b[3;${modParam}~` : '\x1b[3~');
        e.preventDefault();
        break;
      case 'PageUp':
        if (e.shiftKey && !alternateScreenRef.current) {
          requestScrollLines(Math.max(1, gridRowsRef.current - 2));
        } else {
          sendInput(modParam > 1 ? `\x1b[5;${modParam}~` : '\x1b[5~');
        }
        e.preventDefault();
        break;
      case 'PageDown':
        if (e.shiftKey && !alternateScreenRef.current) {
          requestScrollLines(-Math.max(1, gridRowsRef.current - 2));
        } else {
          sendInput(modParam > 1 ? `\x1b[6;${modParam}~` : '\x1b[6~');
        }
        e.preventDefault();
        break;
      case 'F1':
        sendInput(modParam > 1 ? `\x1b[1;${modParam}P` : '\x1bOP');
        e.preventDefault();
        break;
      case 'F2':
        sendInput(modParam > 1 ? `\x1b[1;${modParam}Q` : '\x1bOQ');
        e.preventDefault();
        break;
      case 'F3':
        sendInput(modParam > 1 ? `\x1b[1;${modParam}R` : '\x1bOR');
        e.preventDefault();
        break;
      case 'F4':
        sendInput(modParam > 1 ? `\x1b[1;${modParam}S` : '\x1bOS');
        e.preventDefault();
        break;
      case 'F5':
        sendInput(modParam > 1 ? `\x1b[15;${modParam}~` : '\x1b[15~');
        e.preventDefault();
        break;
      case 'F6':
        sendInput(modParam > 1 ? `\x1b[17;${modParam}~` : '\x1b[17~');
        e.preventDefault();
        break;
      case 'F7':
        sendInput(modParam > 1 ? `\x1b[18;${modParam}~` : '\x1b[18~');
        e.preventDefault();
        break;
      case 'F8':
        sendInput(modParam > 1 ? `\x1b[19;${modParam}~` : '\x1b[19~');
        e.preventDefault();
        break;
      case 'F9':
        sendInput(modParam > 1 ? `\x1b[20;${modParam}~` : '\x1b[20~');
        e.preventDefault();
        break;
      case 'F10':
        sendInput(modParam > 1 ? `\x1b[21;${modParam}~` : '\x1b[21~');
        e.preventDefault();
        break;
      case 'F11':
        sendInput(modParam > 1 ? `\x1b[23;${modParam}~` : '\x1b[23~');
        e.preventDefault();
        break;
      case 'F12':
        sendInput(modParam > 1 ? `\x1b[24;${modParam}~` : '\x1b[24~');
        e.preventDefault();
        break;
      default:
        if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
          sendInput(`\x1b${e.key}`);
          e.preventDefault();
        }
        break;
    }
  };

  const handleInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    if ((e.nativeEvent as InputEvent).isComposing) return;
    const target = e.currentTarget;
    const value = target.value;
    if (value) {
      sendInput(value);
      target.value = '';
    }
  };

  const handleCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget;
    const value = target.value;
    if (value) {
      sendInput(value);
      target.value = '';
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData('text/plain');
    if (text) {
      pasteTextToTerminal(text);
      e.preventDefault();
    }
  };

  // Convert mouse client coordinates to grid (col, row) and grid-relative pixels
  const clientToGrid = useCallback(
    (
      clientX: number,
      clientY: number
    ): { col: number; row: number; pxX: number; pxY: number } => {
      const canvas = canvasRef.current;
      if (!canvas) return { col: 0, row: 0, pxX: 1, pxY: 1 };
      const cached = cachedRectRef.current;
      const rect =
        cached && cached.width >= 4 && cached.height >= 4
          ? cached
          : (cachedRectRef.current = canvas.getBoundingClientRect());
      const cellW = cellWidthRef.current || 8;
      const cellH = cellHeightRef.current || 16;
      const ox = PAD_X;
      const oy = PAD_Y + spareYRef.current;

      const relX = clientX - rect.left - ox;
      const relY = clientY - rect.top - oy;

      const col = Math.max(
        0,
        Math.min(gridColsRef.current - 1, Math.floor(relX / cellW))
      );
      const row = Math.max(
        0,
        Math.min(gridRowsRef.current - 1, Math.floor(relY / cellH))
      );
      const pxX = Math.max(1, Math.round(relX) + 1);
      const pxY = Math.max(1, Math.round(relY) + 1);
      return { col, row, pxX, pxY };
    },
    []
  );

  // Encode SGR / SGR-Pixels / X10 mouse event sequence
  const encodeMouseReport = useCallback(
    (
      baseButtonCode: number,
      isRelease: boolean,
      pt: { col: number; row: number; pxX: number; pxY: number },
      mods: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }
    ): string => {
      const modBits =
        (mods.shiftKey ? 4 : 0) |
        (mods.altKey ? 8 : 0) |
        (mods.ctrlKey || mods.metaKey ? 16 : 0);
      const cb = baseButtonCode | modBits;

      if (sgrPixelsMouseRef.current) {
        return `\x1b[<${cb};${pt.pxX};${pt.pxY}${isRelease ? 'm' : 'M'}`;
      }
      const cx = pt.col + 1;
      const cy = pt.row + 1;
      if (sgrMouseRef.current || cx > 223 || cy > 223) {
        return `\x1b[<${cb};${cx};${cy}${isRelease ? 'm' : 'M'}`;
      }
      // Legacy X10 / Normal mouse mode
      const x10Cb = isRelease ? 3 | modBits : cb;
      return `\x1b[M${String.fromCharCode(32 + x10Cb)}${String.fromCharCode(
        32 + cx
      )}${String.fromCharCode(32 + cy)}`;
    },
    []
  );

  // Expand selection point according to selectionMode ('char' | 'word' | 'line')
  const computeExpandedSelection = useCallback(
    (anchor: SelectionPoint, current: SelectionPoint): [SelectionPoint, SelectionPoint] => {
      const mode = selectionModeRef.current;
      const cols = gridColsRef.current;
      if (mode === 'char') {
        return [anchor, current];
      }

      const first =
        anchor.row < current.row || (anchor.row === current.row && anchor.col <= current.col)
          ? anchor
          : current;
      const second = first === anchor ? current : anchor;

      if (mode === 'line') {
        return [
          { row: first.row, col: 0 },
          { row: second.row, col: cols },
        ];
      }

      // Word mode
      const expandWordOnRow = (rowIdx: number, colIdx: number): [number, number] => {
        const row = matrixRef.current[rowIdx];
        if (!row || row.length === 0) return [colIdx, Math.min(cols, colIdx + 1)];
        const clampedCol = Math.max(0, Math.min(row.length - 1, colIdx));
        const ch = row[clampedCol]?.ch || ' ';
        if (!isWordChar(ch)) {
          return [clampedCol, Math.min(cols, clampedCol + 1)];
        }
        let start = clampedCol;
        while (start > 0 && isWordChar(row[start - 1]?.ch || ' ')) {
          start--;
        }
        let end = clampedCol + 1;
        while (end < row.length && isWordChar(row[end]?.ch || ' ')) {
          end++;
        }
        return [start, end];
      };

      const [startCol] = expandWordOnRow(first.row, first.col);
      const [, endCol] = expandWordOnRow(second.row, second.col);
      return [
        { row: first.row, col: startCol },
        { row: second.row, col: endCol },
      ];
    },
    []
  );

  // Find link at grid (row, col)
  const findLinkAtCell = useCallback((rowIdx: number, colIdx: number): HoveredLinkSpan | null => {
    const row = matrixRef.current[rowIdx];
    if (!row || row.length === 0) return null;

    let rowText = '';
    const charIndexToCol: number[] = [];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (!cell || cell.width === 0) continue;
      const ch = cell.ch || ' ';
      for (let i = 0; i < ch.length; i++) {
        charIndexToCol.push(c);
      }
      rowText += ch;
    }

    const links = extractTerminalLinks(rowText);
    for (const link of links) {
      const startCol = charIndexToCol[link.start] ?? link.start;
      const lastCharCol = charIndexToCol[Math.max(0, link.end - 1)] ?? link.end - 1;
      const endCol = lastCharCol + 1;
      if (colIdx >= startCol && colIdx < endCol) {
        return {
          row: rowIdx,
          startCol,
          endCol,
          kind: link.kind,
          text: link.text,
        };
      }
    }
    return null;
  }, []);

  const stopSelectionAutoScroll = useCallback(() => {
    if (selectionAutoScrollTimerRef.current !== null) {
      window.clearInterval(selectionAutoScrollTimerRef.current);
      selectionAutoScrollTimerRef.current = null;
    }
  }, []);

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    fastPollUntilRef.current = performance.now() + 250;
    inputRef.current?.focus();
    if (canvasRef.current) {
      cachedRectRef.current = canvasRef.current.getBoundingClientRect();
    }

    const pt = clientToGrid(e.clientX, e.clientY);

    // 1. Ctrl/Cmd + Left Click on a link opens the link immediately
    if ((e.ctrlKey || e.metaKey) && e.button === 0) {
      const link = findLinkAtCell(pt.row, pt.col);
      if (link) {
        e.preventDefault();
        const candidate = link.text.trim().replace(/^['"`(<\[]+|['"`)>\].,;:]+$/g, '');
        if (link.kind === 'web') {
          openTerminalWebLink(candidate, workspaceIdRef.current);
        } else {
          openFileInRightDock({
            candidate,
            workspaceId: workspaceIdRef.current,
            collapseTree: true,
          });
        }
        return;
      }
    }

    // 2. When the TUI application has enabled mouse reporting (and Shift is not held),
    // forward the mouse button press to the PTY (OpenCode clickable buttons, sessions, tabs, etc.)
    const takesMouse = mouseModeRef.current !== 'none' && !e.shiftKey;
    if (takesMouse && (e.button === 0 || e.button === 1 || e.button === 2)) {
      e.preventDefault();
      const bit = 1 << e.button;
      buttonsDownRef.current |= bit;
      lastMouseReportRef.current = {
        col: pt.col,
        row: pt.row,
        buttons: buttonsDownRef.current,
      };
      const seq = encodeMouseReport(e.button, false, pt, e);
      sendInput(seq, false);
      return;
    }

    // 3. Otherwise, handle local selection (single = char, double = word, triple = line)
    if (e.button !== 0) return;

    const clicks = e.detail || 1;
    const mode: 'char' | 'word' | 'line' =
      clicks >= 3 ? 'line' : clicks === 2 ? 'word' : 'char';
    selectionModeRef.current = mode;
    isSelectingRef.current = true;

    const anchor = { col: pt.col, row: pt.row };
    selectionAnchorRef.current = anchor;
    const [start, end] = computeExpandedSelection(anchor, anchor);
    selectionStartRef.current = start;
    selectionEndRef.current = end;
    scheduleRender();

    // Attach window-level drag listeners so dragging outside viewport auto-scrolls smoothly
    const onWindowMouseMove = (we: MouseEvent) => {
      if (!isSelectingRef.current || !selectionAnchorRef.current) return;
      lastDragClientXRef.current = we.clientX;
      lastDragClientYRef.current = we.clientY;

      const curPt = clientToGrid(we.clientX, we.clientY);
      const [s, en] = computeExpandedSelection(selectionAnchorRef.current, {
        col: curPt.col,
        row: curPt.row,
      });
      selectionStartRef.current = s;
      selectionEndRef.current = en;
      scheduleRender();

      // Auto-scroll when dragging above or below the canvas in primary screen
      const canvas = canvasRef.current;
      if (canvas && !alternateScreenRef.current) {
        const rect = canvas.getBoundingClientRect();
        const overTop = rect.top - we.clientY;
        const overBottom = we.clientY - rect.bottom;
        if (overTop > 4 || overBottom > 4) {
          if (selectionAutoScrollTimerRef.current === null) {
            selectionAutoScrollTimerRef.current = window.setInterval(() => {
              const cy = lastDragClientYRef.current;
              const cx = lastDragClientXRef.current;
              const cEl = canvasRef.current;
              if (cy === null || cx === null || !cEl || !selectionAnchorRef.current) return;
              const r = cEl.getBoundingClientRect();
              const cellH = cellHeightRef.current || 16;
              let deltaLines = 0;
              if (cy < r.top) {
                deltaLines = Math.min(8, Math.max(1, Math.ceil((r.top - cy) / cellH)));
              } else if (cy > r.bottom) {
                deltaLines = -Math.min(8, Math.max(1, Math.ceil((cy - r.bottom) / cellH)));
              }
              if (deltaLines !== 0) {
                requestScrollLines(deltaLines);
              }
            }, 50);
          }
        } else {
          stopSelectionAutoScroll();
        }
      }
    };

    const onWindowMouseUp = () => {
      window.removeEventListener('mousemove', onWindowMouseMove);
      window.removeEventListener('mouseup', onWindowMouseUp);
      stopSelectionAutoScroll();
      if (isSelectingRef.current) {
        isSelectingRef.current = false;
        copySelectionToClipboard();
      }
    };

    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const pt = clientToGrid(e.clientX, e.clientY);

    // Update Ctrl+Hover link state
    if ((e.ctrlKey || e.metaKey) && !isSelectingRef.current && buttonsDownRef.current === 0) {
      const link = findLinkAtCell(pt.row, pt.col);
      const prev = hoveredLinkRef.current;
      const changed =
        prev?.row !== link?.row ||
        prev?.startCol !== link?.startCol ||
        prev?.endCol !== link?.endCol;
      if (changed) {
        hoveredLinkRef.current = link;
        setPointerCursor(Boolean(link));
        if (canvasRef.current) {
          if (link) {
            canvasRef.current.title =
              link.kind === 'web'
                ? getTerminalWebLinksTarget() === 'external'
                  ? 'Ctrl + Click para abrir en el navegador externo'
                  : 'Ctrl + Click para abrir en el navegador integrado'
                : 'Ctrl + Click para previsualizar archivo';
          } else {
            canvasRef.current.title = '';
          }
        }
        scheduleRender();
      }
    } else if (hoveredLinkRef.current) {
      hoveredLinkRef.current = null;
      setPointerCursor(false);
      if (canvasRef.current) canvasRef.current.title = '';
      scheduleRender();
    }

    // Forward mouse motion to PTY when mouseMode is 'drag' or 'any'
    const mode = mouseModeRef.current;
    const takesMouse = mode !== 'none' && !e.shiftKey;
    if (takesMouse && !isSelectingRef.current) {
      const buttons = buttonsDownRef.current;
      if (mode === 'click') return;
      if (mode === 'drag' && buttons === 0) return;

      const last = lastMouseReportRef.current;
      if (
        !sgrPixelsMouseRef.current &&
        last &&
        last.col === pt.col &&
        last.row === pt.row &&
        last.buttons === buttons
      ) {
        return;
      }
      lastMouseReportRef.current = { col: pt.col, row: pt.row, buttons };

      const motionCode =
        buttons & 1 ? 32 : buttons & 2 ? 33 : buttons & 4 ? 34 : 35;
      const seq = encodeMouseReport(motionCode, false, pt, e);
      sendInput(seq, false);
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const bit = 1 << e.button;
    const wasDown = (buttonsDownRef.current & bit) !== 0;
    buttonsDownRef.current &= ~bit;

    const takesMouse = mouseModeRef.current !== 'none' && !e.shiftKey;
    if ((takesMouse || wasDown) && (e.button === 0 || e.button === 1 || e.button === 2)) {
      const pt = clientToGrid(e.clientX, e.clientY);
      lastMouseReportRef.current = {
        col: pt.col,
        row: pt.row,
        buttons: buttonsDownRef.current,
      };
      const seq = encodeMouseReport(e.button, true, pt, e);
      sendInput(seq, false);
    }
  };

  const handleMouseLeave = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (hoveredLinkRef.current) {
      hoveredLinkRef.current = null;
      setPointerCursor(false);
      if (canvasRef.current) canvasRef.current.title = '';
      scheduleRender();
    }
    if (buttonsDownRef.current !== 0) {
      const pt = clientToGrid(e.clientX, e.clientY);
      for (let b = 0; b <= 2; b++) {
        if (buttonsDownRef.current & (1 << b)) {
          const seq = encodeMouseReport(b, true, pt, e);
          sendInput(seq, false);
        }
      }
      buttonsDownRef.current = 0;
      lastMouseReportRef.current = null;
    }
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    inputRef.current?.focus();
    // If TUI captures mouse and Shift isn't held, right-click was already sent as button 2
    if (mouseModeRef.current !== 'none' && !e.shiftKey) {
      return;
    }
    if (copySelectionToClipboard()) {
      selectionStartRef.current = null;
      selectionEndRef.current = null;
      scheduleRender();
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      void navigator.clipboard.readText().then((txt) => {
        if (txt) pasteTextToTerminal(txt);
      });
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    fastPollUntilRef.current = performance.now() + 250;

    const discreteAxis = (delta: number) => {
      const abs = Math.abs(delta);
      return (
        e.deltaMode === 1 ||
        e.deltaMode === 2 ||
        (e.deltaMode === 0 && abs >= 80 && Number.isInteger(delta))
      );
    };
    const consume = (
      delta: number,
      accum: { current: number },
      trackUnit: number,
      cap: number,
    ) => {
      if (!delta) return 0;
      if (discreteAxis(delta)) {
        accum.current = 0;
        return delta < 0 ? -1 : 1;
      }
      accum.current += delta;
      let steps = Math.trunc(accum.current / trackUnit);
      if (steps === 0) return 0;
      accum.current -= steps * trackUnit;
      if (cap > 0) steps = Math.max(-cap, Math.min(cap, steps));
      return steps;
    };

    const takesMouse = mouseModeRef.current !== 'none' && !e.shiftKey;
    const alt = alternateScreenRef.current;
    const cellH = Math.max(1, cellHeightRef.current || 16);
    const reportWheel = takesMouse || alt;
    const trackUnit = reportWheel ? Math.max(16, cellH * 1.25) : cellH;
    const cap = reportWheel ? 3 : 0;
    const stepsY = consume(e.deltaY, wheelAccumYRef, trackUnit, cap);
    const stepsX = reportWheel ? consume(e.deltaX, wheelAccumXRef, trackUnit, cap) : 0;
    const pt = clientToGrid(e.clientX, e.clientY);

    if (takesMouse) {
      let out = '';
      if (stepsY !== 0) {
        const wheelCode = stepsY < 0 ? 64 : 65;
        out += encodeMouseReport(wheelCode, false, pt, e).repeat(Math.abs(stepsY));
      }
      if (stepsX !== 0) {
        const wheelCodeX = stepsX < 0 ? 66 : 67;
        out += encodeMouseReport(wheelCodeX, false, pt, e).repeat(Math.abs(stepsX));
      }
      if (out) {
        sendInput(out, false);
        immediatePollRef.current?.();
      }
      return;
    }

    if (stepsY === 0) return;

    if (alt) {
      const seq =
        stepsY < 0
          ? applicationCursorRef.current
            ? '\x1bOA'
            : '\x1b[A'
          : applicationCursorRef.current
            ? '\x1bOB'
            : '\x1b[B';
      sendInput(seq.repeat(Math.abs(stepsY)), false);
      immediatePollRef.current?.();
      return;
    }

    const lines = discreteAxis(e.deltaY) ? (stepsY < 0 ? 3 : -3) : -stepsY;
    requestScrollLines(lines);
  };

  return (
    <div
      ref={containerRef}
      className={`terminal-canvas-surface-container ${className}`}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        backgroundColor: DEFAULT_BG_HEX,
        cursor: pointerCursor
          ? 'pointer'
          : mouseModeRef.current !== 'none'
            ? 'default'
            : 'text',
      }}
      onClick={() => inputRef.current?.focus()}
    >
      <canvas
        ref={canvasRef}
        className="terminal-canvas-surface"
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onContextMenu={handleContextMenu}
        onWheel={handleWheel}
      />
      <textarea
        ref={inputRef}
        className="terminal-canvas-surface__input"
        aria-label="Terminal Input"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '1px',
          height: '1px',
          opacity: 0,
          pointerEvents: 'none',
          padding: 0,
          border: 'none',
          outline: 'none',
          resize: 'none',
          overflow: 'hidden',
        }}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        onCompositionEnd={handleCompositionEnd}
        onPaste={handlePaste}
        onFocus={() => {
          const changed = !isFocusedRef.current;
          isFocusedRef.current = true;
          if (changed && focusReportingRef.current) {
            sendInput('\x1b[I', false);
          }
          scheduleRender();
          onFocus?.();
        }}
        onBlur={() => {
          const changed = isFocusedRef.current;
          isFocusedRef.current = false;
          if (changed && focusReportingRef.current) {
            sendInput('\x1b[O', false);
          }
          scheduleRender();
          onBlur?.();
        }}
      />
    </div>
  );
};
