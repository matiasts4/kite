import React, { useRef, useCallback, useEffect } from 'react';
import { openFileInRightDock } from '../../../../lib/filePreviewNav';
import {
  extractTerminalLinks,
  openTerminalWebLink,
  getTerminalWebLinksTarget,
} from '../../../../lib/terminalLinkNav';
import {
  type CellSnapshot,
  type HoveredLinkSpan,
  type SelectionPoint,
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
  alternateScreenRef?: React.MutableRefObject<boolean>;
  applicationCursorRef?: React.MutableRefObject<boolean>;
  mouseTrackingRef: React.MutableRefObject<boolean>;
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
  scheduleRender: () => void;
  requestScrollLines: (delta: number) => void;
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
    mouseTrackingRef,
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
    setPointerCursor,
    onFocusInput,
    armFastPoll,
  } = options;

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
      const matrix = matrixRef.current;

      if (mode === 'word') {
        const rowStart = matrix[s.row];
        if (rowStart) {
          while (s.col > 0 && isWordChar(rowStart[s.col - 1]?.ch || '')) {
            s.col--;
          }
        }
        const rowEnd = matrix[e.row];
        if (rowEnd) {
          while (e.col < rowEnd.length - 1 && isWordChar(rowEnd[e.col + 1]?.ch || '')) {
            e.col++;
          }
        }
      } else if (mode === 'line') {
        s.col = 0;
        const rowEnd = matrix[e.row];
        e.col = rowEnd ? Math.max(0, rowEnd.length - 1) : gridColsRef.current - 1;
      }

      return [s, e];
    },
    [gridColsRef, matrixRef]
  );

  const findLinkAtCell = useCallback(
    (rowIdx: number, colIdx: number): HoveredLinkSpan | null => {
      const row = matrixRef.current[rowIdx];
      if (!row) return null;
      const fullText = row.map((c) => (c ? c.ch : ' ')).join('');
      const links = extractTerminalLinks(fullText);

      for (const link of links) {
        const startCol = link.start;
        const endCol = link.end;
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
    },
    [matrixRef]
  );

  const stopSelectionAutoScroll = useCallback(() => {
    if (selectionAutoScrollTimerRef.current !== null) {
      window.clearInterval(selectionAutoScrollTimerRef.current);
      selectionAutoScrollTimerRef.current = null;
    }
  }, []);

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

    const matrix = matrixRef.current;
    const lines: string[] = [];
    for (let r = selStart.row; r <= selEnd.row && r < matrix.length; r++) {
      const row = matrix[r];
      if (!row) {
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
    if (text && typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text);
      return true;
    }
    return false;
  }, [matrixRef, selectionEndRef, selectionStartRef]);

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    armFastPoll(1000);
    onFocusInput();
    if (canvasRef.current) {
      cachedRectRef.current = canvasRef.current.getBoundingClientRect();
    }

    const pt = clientToGrid(e.clientX, e.clientY);

    // 1. Ctrl/Cmd + Click link navigation
    if ((e.ctrlKey || e.metaKey) && e.button === 0) {
      const link = findLinkAtCell(pt.row, pt.col);
      if (link) {
        e.preventDefault();
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
        return;
      }
    }

    // 2. App mouse tracking
    const takesMouse = mouseTrackingRef.current && mouseModeRef.current !== 'none' && !e.shiftKey;
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
    const takesMouse = mouseTrackingRef.current && mode !== 'none' && !e.shiftKey;
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

    const takesMouse = mouseTrackingRef.current && mouseModeRef.current !== 'none' && !e.shiftKey;
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
    onFocusInput();
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
    if (pasteTextToTerminal && typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      void navigator.clipboard.readText().then((txt) => {
        if (txt) pasteTextToTerminal(txt);
      });
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    armFastPoll(250);

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

    const takesMouse = mouseTrackingRef.current && mouseModeRef.current !== 'none' && !e.shiftKey;
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
      return;
    }

    const lines = discreteAxis(e.deltaY) ? (stepsY < 0 ? 3 : -3) : -stepsY;
    requestScrollLines(lines);
  };

  return {
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleMouseLeave,
    handleContextMenu,
    handleWheel,
    copySelectionToClipboard,
    stopSelectionAutoScroll,
  };
}
