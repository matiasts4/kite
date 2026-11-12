import React, { useRef, useCallback, useEffect } from 'react';
import { invokeCommand } from '../../../../lib/ipc';
import { openFileInRightDock } from '../../../../lib/filePreviewNav';
import {
  openTerminalWebLink,
  getTerminalWebLinksTarget,
} from '../../../../lib/terminalLinkNav';
import { findGridLink } from './terminalGridText';
import {
  type CellSnapshot,
  type HoveredLinkSpan,
  type SelectionPoint,
  selectionRows,
  type TerminalMouseMode,
  PAD_X,
  PAD_Y,
  isWordChar,
} from './terminalCanvasTypes';

export interface UseTerminalMouseTrackingOptions {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  cachedRectRef: React.MutableRefObject<DOMRect | null>;
  gridColsRef: React.MutableRefObject<number>;
  gridRowsRef: React.MutableRefObject<number>;
  cellWidthRef: React.MutableRefObject<number>;
  cellHeightRef: React.MutableRefObject<number>;
  spareYRef: React.MutableRefObject<number>;
  matrixRef: React.MutableRefObject<CellSnapshot[][]>;
  rowWrappedRef?: React.MutableRefObject<boolean[]>;
  rowCacheRef?: React.MutableRefObject<Map<number, CellSnapshot[]>>;
  scrollbackOffsetRef?: React.MutableRefObject<number>;
  sessionId?: string;
  alternateScreenRef?: React.MutableRefObject<boolean>;
  applicationCursorRef?: React.MutableRefObject<boolean>;
  mouseModeRef: React.MutableRefObject<TerminalMouseMode>;
  sgrMouseRef: React.MutableRefObject<boolean>;
  sgrPixelsMouseRef: React.MutableRefObject<boolean>;
  buttonsDownRef?: React.MutableRefObject<number>;
  lastMouseReportRef?: React.MutableRefObject<{ col: number; row: number; buttons: number } | null>;
  selectionStartRef: React.MutableRefObject<SelectionPoint | null>;
  selectionEndRef: React.MutableRefObject<SelectionPoint | null>;
  selectionAnchorRef?: React.MutableRefObject<SelectionPoint | null>;
  hoveredLinkRef: React.MutableRefObject<HoveredLinkSpan | null>;
  workspaceId?: string | null;
  sendInput: (data: string, trackUser?: boolean) => void;
  pasteTextToTerminal?: (text: string) => void;
  scheduleRender: (rows?: number[]) => void;
  requestScrollLines: (delta: number) => void;
  /** Wheel activity. The surface uses this to raise the paint clock for one gesture. */
  onWheelActivity?: () => void;
  setPointerCursor: (pointer: boolean) => void;
  onFocusInput: () => void;
  armFastPoll: (ms: number) => void;
}

export function useTerminalMouseTracking(options: UseTerminalMouseTrackingOptions) {
  const {
    canvasRef,
    cachedRectRef,
    gridColsRef,
    gridRowsRef,
    cellWidthRef,
    cellHeightRef,
    spareYRef,
    matrixRef,
    rowWrappedRef,
    sessionId,
    mouseModeRef,
    sgrMouseRef,
    sgrPixelsMouseRef,
    selectionStartRef,
    selectionEndRef,
    hoveredLinkRef,
    workspaceId = null,
    sendInput,
    pasteTextToTerminal,
    scheduleRender,
    requestScrollLines,
    onWheelActivity,
    setPointerCursor,
    onFocusInput,
    armFastPoll,
  } = options;

  const internalWrappedRef = useRef<boolean[]>([]);
  const wrappedRef = rowWrappedRef ?? internalWrappedRef;
  const internalRowCacheRef = useRef<Map<number, CellSnapshot[]>>(new Map());
  const rowCacheRef = options.rowCacheRef ?? internalRowCacheRef;
  const internalScrollbackOffsetRef = useRef<number>(0);
  const scrollbackOffsetRef = options.scrollbackOffsetRef ?? internalScrollbackOffsetRef;
  const internalAltRef = useRef<boolean>(false);
  const alternateScreenRef = options.alternateScreenRef ?? internalAltRef;
  const internalAppCursorRef = useRef<boolean>(false);
  const applicationCursorRef = options.applicationCursorRef ?? internalAppCursorRef;
  const internalButtonsDownRef = useRef<number>(0);
  const buttonsDownRef = options.buttonsDownRef ?? internalButtonsDownRef;
  const internalLastMouseReportRef = useRef<{ col: number; row: number; buttons: number } | null>(null);
  const lastMouseReportRef = options.lastMouseReportRef ?? internalLastMouseReportRef;
  const internalSelectionAnchorRef = useRef<SelectionPoint | null>(null);
  const selectionAnchorRef = options.selectionAnchorRef ?? internalSelectionAnchorRef;

  const isSelectingRef = useRef<boolean>(false);
  const selectionModeRef = useRef<'char' | 'word' | 'line'>('char');
  const selectionAutoScrollTimerRef = useRef<number | null>(null);
  const lastDragClientYRef = useRef<number | null>(null);
  const lastDragClientXRef = useRef<number | null>(null);
  const wheelAccumYRef = useRef<number>(0);
  const wheelAccumXRef = useRef<number>(0);
  const wheelFlushRef = useRef<number | null>(null);
  const pendingWheelLinesRef = useRef(0);
  const pendingWheelInputRef = useRef('');

  useEffect(() => {
    return () => {
      if (selectionAutoScrollTimerRef.current !== null) {
        window.clearInterval(selectionAutoScrollTimerRef.current);
        selectionAutoScrollTimerRef.current = null;
      }
    };
  }, []);

  const clientToGrid = useCallback(
    (clientX: number, clientY: number): { col: number; row: number; pxX: number; pxY: number } => {
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

      const col = Math.max(0, Math.min(gridColsRef.current - 1, Math.floor(relX / cellW)));
      const row = Math.max(0, Math.min(gridRowsRef.current - 1, Math.floor(relY / cellH)));
      const pxX = Math.max(1, Math.round(relX) + 1);
      const pxY = Math.max(1, Math.round(relY) + 1);
      return { col, row, pxX, pxY };
    },
    [cachedRectRef, canvasRef, cellHeightRef, cellWidthRef, gridColsRef, gridRowsRef, spareYRef]
  );

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
      const x10Cb = isRelease ? 3 | modBits : cb;
      return `\x1b[M${String.fromCharCode(32 + x10Cb)}${String.fromCharCode(32 + Math.min(255, cx))}${String.fromCharCode(32 + Math.min(255, cy))}`;
    },
    [sgrMouseRef, sgrPixelsMouseRef]
  );

  const getRowByRelIndex = useCallback(
    (relRow: number): CellSnapshot[] | undefined => {
      const offset = scrollbackOffsetRef.current;
      const vRow = relRow + offset;
      const matrix = matrixRef.current;
      if (vRow >= 0 && vRow < matrix.length) {
        return matrix[vRow];
      }
      return rowCacheRef.current.get(relRow);
    },
    [matrixRef, rowCacheRef, scrollbackOffsetRef]
  );

  const computeExpandedSelection = useCallback(
    (anchor: SelectionPoint, current: SelectionPoint): [SelectionPoint, SelectionPoint] => {
      let s: SelectionPoint = { ...anchor };
      let e: SelectionPoint = { ...current };

      const isReversed = s.row > e.row || (s.row === e.row && s.col > e.col);
      if (isReversed) {
        const tmp = s;
        s = e;
        e = tmp;
      }

      const mode = selectionModeRef.current;

      if (mode === 'word') {
        const rowStart = getRowByRelIndex(s.row);
        if (rowStart) {
          while (s.col > 0 && isWordChar(rowStart[s.col - 1]?.ch || '')) {
            s.col--;
          }
        }
        const rowEnd = getRowByRelIndex(e.row);
        if (rowEnd) {
          while (e.col < rowEnd.length - 1 && isWordChar(rowEnd[e.col + 1]?.ch || '')) {
            e.col++;
          }
        }
      } else if (mode === 'line') {
        s.col = 0;
        const rowEnd = getRowByRelIndex(e.row);
        e.col = rowEnd ? Math.max(0, rowEnd.length - 1) : gridColsRef.current - 1;
      }

      return [s, e];
    },
    [getRowByRelIndex, gridColsRef]
  );

  const findLinkAtCell = useCallback(
    (rowIdx: number, colIdx: number): HoveredLinkSpan | null => {
      return findGridLink(matrixRef.current, wrappedRef.current, rowIdx, colIdx);
    },
    [matrixRef, wrappedRef]
  );

  const stopSelectionAutoScroll = useCallback(() => {
    if (selectionAutoScrollTimerRef.current !== null) {
      window.clearInterval(selectionAutoScrollTimerRef.current);
      selectionAutoScrollTimerRef.current = null;
    }
  }, []);

  const updateDragSelectionFromClientPoint = useCallback(
    (clientX: number, clientY: number) => {
      if (!isSelectingRef.current || !selectionAnchorRef.current) return;
      const offset = scrollbackOffsetRef.current;
      const curPt = clientToGrid(clientX, clientY);
      const previousStart = selectionStartRef.current;
      const previousEnd = selectionEndRef.current;
      const [s, en] = computeExpandedSelection(selectionAnchorRef.current, {
        col: curPt.col,
        row: curPt.row - offset,
      });
      selectionStartRef.current = s;
      selectionEndRef.current = en;
      scheduleRender([
        ...selectionRows(previousStart, previousEnd, offset, gridRowsRef.current),
        ...selectionRows(s, en, offset, gridRowsRef.current),
      ]);
    },
    [
      clientToGrid,
      computeExpandedSelection,
      gridRowsRef,
      scheduleRender,
      scrollbackOffsetRef,
      selectionAnchorRef,
      selectionEndRef,
      selectionStartRef,
    ]
  );

  const syncSelectionOnScroll = useCallback(() => {
    if (
      !isSelectingRef.current ||
      !selectionAnchorRef.current ||
      lastDragClientXRef.current === null ||
      lastDragClientYRef.current === null
    ) {
      return;
    }
    updateDragSelectionFromClientPoint(lastDragClientXRef.current, lastDragClientYRef.current);
  }, [updateDragSelectionFromClientPoint]);

  const copySelectionToClipboard = useCallback((): boolean => {
    let selStart = selectionStartRef.current;
    let selEnd = selectionEndRef.current;
    if (!selStart || !selEnd || (selStart.row === selEnd.row && selStart.col === selEnd.col)) {
      return false;
    }
    if (selStart.row > selEnd.row || (selStart.row === selEnd.row && selStart.col > selEnd.col)) {
      const tmp = selStart;
      selStart = selEnd;
      selEnd = tmp;
    }

    const offset = scrollbackOffsetRef.current;
    const matrix = matrixRef.current;
    const lines: string[] = [];
    let missingOffscreenRows = false;

    for (let r = selStart.row; r <= selEnd.row; r++) {
      const row = getRowByRelIndex(r);
      if (!row) {
        const vRow = r + offset;
        if (vRow < 0 || vRow >= matrix.length) {
          missingOffscreenRows = true;
        }
        lines.push('');
        continue;
      }
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
    const canWriteClipboard =
      typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.writeText);
    if (text && canWriteClipboard) {
      void navigator.clipboard.writeText(text);
    }

    const spansOffscreen =
      selStart.row + offset < 0 ||
      selEnd.row + offset >= matrix.length ||
      missingOffscreenRows;

    if (spansOffscreen && sessionId && canWriteClipboard) {
      const reqStart = { ...selStart };
      const reqEnd = { ...selEnd };
      void invokeCommand<{ text?: string }>('get_terminal_selection_text', {
        sessionId,
        startRow: reqStart.row,
        startCol: reqStart.col,
        endRow: reqEnd.row,
        endCol: reqEnd.col,
      })
        .then((res) => {
          if (res && typeof res.text === 'string' && res.text.length > 0) {
            void navigator.clipboard.writeText(res.text);
          }
        })
        .catch(() => {});
      return true;
    }

    return Boolean(text && canWriteClipboard);
  }, [
    getRowByRelIndex,
    matrixRef,
    scrollbackOffsetRef,
    selectionEndRef,
    selectionStartRef,
    sessionId,
  ]);

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    armFastPoll(1000);
    onFocusInput();
    if (canvasRef.current) {
      cachedRectRef.current = canvasRef.current.getBoundingClientRect();
    }

    const pt = clientToGrid(e.clientX, e.clientY);

    const openLink = (link: HoveredLinkSpan) => {
      const candidate = link.text.trim().replace(/^['"`(<\[]+|['"`)>\].,;:]+$/g, '');
      if (link.kind === 'web') {
        openTerminalWebLink(candidate, workspaceId);
      } else {
        openFileInRightDock({
          candidate,
          workspaceId,
          collapseTree: true,
        });
      }
    };

    // 1. Ctrl/Cmd + Click always opens a link, even while the TUI owns the mouse.
    if ((e.ctrlKey || e.metaKey) && e.button === 0) {
      const link = findLinkAtCell(pt.row, pt.col);
      if (link) {
        e.preventDefault();
        openLink(link);
        return;
      }
    }

    // Plain click opens a link only when the terminal is not reporting the mouse.
    if (e.button === 0 && !e.shiftKey && mouseModeRef.current === 'none') {
      const link = findLinkAtCell(pt.row, pt.col);
      if (link) {
        e.preventDefault();
        openLink(link);
        return;
      }
    }

    // 2. App mouse tracking
    const takesMouse = mouseModeRef.current !== 'none' && !e.shiftKey;
    if (takesMouse && (e.button === 0 || e.button === 1 || e.button === 2)) {
      buttonsDownRef.current |= 1 << e.button;
      lastMouseReportRef.current = {
        col: pt.col,
        row: pt.row,
        buttons: buttonsDownRef.current,
      };
      const seq = encodeMouseReport(e.button, false, pt, e);
      sendInput(seq, false);
      e.preventDefault();
      return;
    }

    // 3. Otherwise, handle local selection (single = char, double = word, triple = line)
    if (e.button !== 0) return;
    e.preventDefault();

    const clicks = e.detail || 1;
    const mode: 'char' | 'word' | 'line' =
      clicks >= 3 ? 'line' : clicks === 2 ? 'word' : 'char';
    selectionModeRef.current = mode;
    isSelectingRef.current = true;
    lastDragClientXRef.current = e.clientX;
    lastDragClientYRef.current = e.clientY;

    const offset = scrollbackOffsetRef.current;
    const anchor = { col: pt.col, row: pt.row - offset };
    selectionAnchorRef.current = anchor;
    const previousStart = selectionStartRef.current;
    const previousEnd = selectionEndRef.current;
    const [start, end] = computeExpandedSelection(anchor, anchor);
    selectionStartRef.current = start;
    selectionEndRef.current = end;
    scheduleRender([
      ...selectionRows(previousStart, previousEnd, offset, gridRowsRef.current),
      ...selectionRows(start, end, offset, gridRowsRef.current),
    ]);

    // Attach window-level drag listeners so dragging outside viewport auto-scrolls smoothly
    const onWindowMouseMove = (we: MouseEvent) => {
      if (!isSelectingRef.current || !selectionAnchorRef.current) return;
      lastDragClientXRef.current = we.clientX;
      lastDragClientYRef.current = we.clientY;

      updateDragSelectionFromClientPoint(we.clientX, we.clientY);

      // Auto-scroll when dragging near or beyond top/bottom of the canvas in primary screen
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
      }
    };

    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const pt = clientToGrid(e.clientX, e.clientY);

    const hoverLinks =
      mouseModeRef.current === 'none' || e.ctrlKey || e.metaKey;
    if (hoverLinks && !isSelectingRef.current && buttonsDownRef.current === 0) {
      const link = findLinkAtCell(pt.row, pt.col);
      const prev = hoveredLinkRef.current;
      const changed =
        prev?.row !== link?.row ||
        prev?.startCol !== link?.startCol ||
        prev?.endCol !== link?.endCol ||
        prev?.text !== link?.text;
      if (changed) {
        hoveredLinkRef.current = link;
        setPointerCursor(Boolean(link));
        if (canvasRef.current) {
          if (link) {
            const needsModifier = mouseModeRef.current !== 'none';
            const verb = needsModifier ? 'Ctrl + Click' : 'Clic';
            canvasRef.current.title =
              link.kind === 'web'
                ? getTerminalWebLinksTarget() === 'external'
                  ? `${verb} para abrir en el navegador externo`
                  : `${verb} para abrir en el navegador integrado`
                : `${verb} para previsualizar archivo`;
          } else {
            canvasRef.current.title = '';
          }
        }
        scheduleRender(
          [prev?.row, link?.row].filter((row): row is number => typeof row === 'number'),
        );
      }
    } else if (hoveredLinkRef.current) {
      const row = hoveredLinkRef.current.row;
      hoveredLinkRef.current = null;
      setPointerCursor(false);
      if (canvasRef.current) canvasRef.current.title = '';
      scheduleRender([row]);
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
      const row = hoveredLinkRef.current.row;
      hoveredLinkRef.current = null;
      setPointerCursor(false);
      if (canvasRef.current) canvasRef.current.title = '';
      scheduleRender([row]);
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
    onFocusInput();
    // If TUI captures mouse and Shift isn't held, right-click was already sent as button 2
    if (mouseModeRef.current !== 'none' && !e.shiftKey) {
      return;
    }
    if (copySelectionToClipboard()) {
      const start = selectionStartRef.current;
      const end = selectionEndRef.current;
      selectionStartRef.current = null;
      selectionEndRef.current = null;
      scheduleRender(
        selectionRows(start, end, scrollbackOffsetRef.current, gridRowsRef.current),
      );
      return;
    }
    if (pasteTextToTerminal && typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      void navigator.clipboard.readText().then((txt) => {
        if (txt) pasteTextToTerminal(txt);
      });
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    onWheelActivity?.();
    armFastPoll(250);
    if (isSelectingRef.current) {
      lastDragClientXRef.current = e.clientX;
      lastDragClientYRef.current = e.clientY;
    }

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
      if (cap > 0 && Math.abs(steps) > cap) {
        steps = steps > 0 ? cap : -cap;
      }
      accum.current -= steps * trackUnit;
      return steps;
    };

    const takesMouse = mouseModeRef.current !== 'none' && !e.shiftKey;
    const alt = alternateScreenRef.current;
    const cellH = Math.max(1, cellHeightRef.current || 16);
    const reportWheel = takesMouse || alt;
    // One frame may carry a long flick. 120 steps is several pages; the rest stays
    // in the accumulator for the next wheel event instead of being dropped at 3.
    const trackUnit = reportWheel ? Math.max(16, cellH * 1.25) : cellH;
    const cap = reportWheel ? 120 : 0;
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
      if (out) pendingWheelInputRef.current += out;
    } else if (stepsY !== 0 && alt) {
      const seq =
        stepsY < 0
          ? applicationCursorRef.current
            ? '\x1bOA'
            : '\x1b[A'
          : applicationCursorRef.current
            ? '\x1bOB'
            : '\x1b[B';
      pendingWheelInputRef.current += seq.repeat(Math.abs(stepsY));
    } else if (stepsY !== 0) {
      const lines = discreteAxis(e.deltaY) ? (stepsY < 0 ? 3 : -3) : -stepsY;
      pendingWheelLinesRef.current += lines;
    }

    if (!pendingWheelInputRef.current && !pendingWheelLinesRef.current) return;
    if (wheelFlushRef.current !== null) return;
    wheelFlushRef.current = window.requestAnimationFrame(() => {
      wheelFlushRef.current = null;
      const input = pendingWheelInputRef.current;
      const lines = pendingWheelLinesRef.current;
      pendingWheelInputRef.current = '';
      pendingWheelLinesRef.current = 0;
      if (input) sendInput(input, false);
      if (lines) requestScrollLines(lines);
    });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onNativeWheel = (e: WheelEvent) => {
      e.preventDefault();
    };
    canvas.addEventListener('wheel', onNativeWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', onNativeWheel);
      if (wheelFlushRef.current !== null) {
        window.cancelAnimationFrame(wheelFlushRef.current);
        wheelFlushRef.current = null;
      }
    };
  }, [canvasRef]);

  return {
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleMouseLeave,
    handleContextMenu,
    handleWheel,
    copySelectionToClipboard,
    stopSelectionAutoScroll,
    syncSelectionOnScroll,
  };
}
