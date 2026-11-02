import React, { useRef, useEffect, useState, useCallback } from 'react';
import { invokeCommand } from '../../lib/ipc';
import {
  type TerminalAppearancePrefs,
  getTerminalAppearancePrefs,
  TERMINAL_APPEARANCE_CHANGED_EVENT,
} from '../../lib/terminalAppearancePrefs';
import {
  isTerminalDividerDragging,
  onTerminalDividerDragEnd,
} from '../../lib/terminalViewport';
import {
  type SelectionPoint,
  type HoveredLinkSpan,
  type TerminalMouseMode,
  type CellSnapshot,
  type CursorSnapshot,
  type RenderSnapshot,
  measureTerminalCanvasGrid,
  type TerminalCanvasSurfaceProps,
} from './terminal/canvas/terminalCanvasTypes';
import { renderCanvasGrid } from './terminal/canvas/canvasGridRenderer';
import { encodeVtKey, normalizePasteText } from './terminal/canvas/terminalInputKeyEncoder';
import { useTerminalMouseTracking } from './terminal/canvas/useTerminalMouseTracking';
import { useTerminalSnapshotPoller } from './terminal/canvas/useTerminalSnapshotPoller';

export { measureTerminalCanvasGrid };
export type { TerminalCanvasSurfaceProps };

export const TerminalCanvasSurface: React.FC<TerminalCanvasSurfaceProps> = ({
  sessionId,
  workspaceId,
  isFocused,
  className = '',
  onTitleChange,
  onProcessExit,
}) => {
  const [prefs, setPrefs] = useState<TerminalAppearancePrefs>(() =>
    getTerminalAppearancePrefs()
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const isFocusedRef = useRef<boolean>(Boolean(isFocused));
  // Focus is owned by the hidden textarea focus/blur events; the prop only seeds it.
  const rafIdRef = useRef<number | null>(null);

  const cellWidthRef = useRef<number>(9);
  const cellHeightRef = useRef<number>(18);
  const baselineOffsetRef = useRef<number>(14);
  const gridColsRef = useRef<number>(80);
  const gridRowsRef = useRef<number>(24);
  const spareYRef = useRef<number>(0);
  const cachedRectRef = useRef<DOMRect | null>(null);

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
  const buttonsDownRef = useRef<number>(0);
  const lastMouseReportRef = useRef<{ col: number; row: number; buttons: number } | null>(null);
  const lastSeqRef = useRef<number>(0);
  const hasNotifiedExitRef = useRef<boolean>(false);

  const appliedPtyColsRef = useRef<number>(0);
  const appliedPtyRowsRef = useRef<number>(0);
  const resizeInFlightRef = useRef<boolean>(false);
  const scrollInFlightRef = useRef<boolean>(false);
  const pendingScrollLinesRef = useRef<number>(0);
  const scrollFlushTimerRef = useRef<number | null>(null);

  const selectionAnchorRef = useRef<SelectionPoint | null>(null);
  const selectionStartRef = useRef<SelectionPoint | null>(null);
  const selectionEndRef = useRef<SelectionPoint | null>(null);
  const hoveredLinkRef = useRef<HoveredLinkSpan | null>(null);

  const matrixRef = useRef<CellSnapshot[][]>([]);
  const cursorRef = useRef<CursorSnapshot>({
    col: 0,
    row: 0,
    visible: true,
    shape: 'block',
    blink: true,
  });

  const isComposingRef = useRef<boolean>(false);

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

  // Unmount cleanup
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      if (scrollFlushTimerRef.current !== null) {
        window.clearTimeout(scrollFlushTimerRef.current);
        scrollFlushTimerRef.current = null;
      }
    };
  }, []);

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    spareYRef.current = renderCanvasGrid({
      canvas,
      prefs,
      matrix: matrixRef.current,
      cursor: cursorRef.current,
      selection: {
        start: selectionStartRef.current,
        end: selectionEndRef.current,
      },
      hoveredLink: hoveredLinkRef.current,
      isFocused: isFocusedRef.current,
      scrollbackOffset: scrollbackOffsetRef.current,
      cellW: cellWidthRef.current,
      cellH: cellHeightRef.current,
      baseline: baselineOffsetRef.current,
      gridRows: gridRowsRef.current,
      gridCols: gridColsRef.current,
    });
  }, [prefs]);

  const scheduleRender = useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = window.requestAnimationFrame(() => {
      rafIdRef.current = null;
      renderCanvas();
    });
  }, [renderCanvas]);

  const { immediatePoll, armFastPoll, applySnapshot } = useTerminalSnapshotPoller({
    sessionId,
    matrixRef,
    cursorRef,
    alternateScreenRef,
    applicationCursorRef,
    bracketedPasteRef,
    mouseModeRef,
    sgrMouseRef,
    sgrPixelsMouseRef,
    focusReportingRef,
    win32InputModeRef,
    kittyKeyboardFlagsRef,
    scrollbackOffsetRef,
    appliedPtyColsRef,
    appliedPtyRowsRef,
    isFocusedRef,
    onTitleChange,
    onProcessExit,
    scheduleRender,
    resizeInFlightRef,
    lastSeqRef,
    hasNotifiedExitRef,
  });

  const sendInput = useCallback(
    (data: string, clearSelection = true) => {
      if (!data) return;
      armFastPoll(1000);
      void invokeCommand('write_terminal', {
        sessionId,
        input: data,
      }).then(() => {
        immediatePoll();
      });
      if (clearSelection && (selectionStartRef.current || selectionEndRef.current)) {
        selectionStartRef.current = null;
        selectionEndRef.current = null;
        scheduleRender();
      }
    },
    [armFastPoll, immediatePoll, scheduleRender, sessionId]
  );

  const pasteTextToTerminal = useCallback(
    (raw: string) => {
      sendInput(normalizePasteText(raw, bracketedPasteRef.current));
    },
    [sendInput]
  );

  const requestScrollLines = useCallback(
    (lines: number) => {
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
    },
    [applySnapshot, scheduleRender, sessionId]
  );

  const setPointerCursor = useCallback((pointer: boolean) => {
    if (canvasRef.current) {
      canvasRef.current.style.cursor = pointer ? 'pointer' : 'text';
    }
  }, []);

  const {
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleMouseLeave,
    handleContextMenu,
    handleWheel,
    copySelectionToClipboard,
  } = useTerminalMouseTracking({
    canvasRef,
    cachedRectRef,
    gridColsRef,
    gridRowsRef,
    cellWidthRef,
    cellHeightRef,
    spareYRef,
    matrixRef,
    alternateScreenRef,
    applicationCursorRef,
    mouseModeRef,
    sgrMouseRef,
    sgrPixelsMouseRef,
    buttonsDownRef,
    lastMouseReportRef,
    selectionStartRef,
    selectionEndRef,
    selectionAnchorRef,
    hoveredLinkRef,
    workspaceId,
    sendInput,
    pasteTextToTerminal,
    scheduleRender,
    requestScrollLines,
    setPointerCursor,
    onFocusInput: () => inputRef.current?.focus(),
    armFastPoll,
  });

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
      armFastPoll(350);

      void invokeCommand('resize_terminal', {
        sessionId,
        columns: metrics.cols,
        rows: metrics.rows,
      })
        .catch(() => {})
        .finally(() => {
          resizeInFlightRef.current = false;
          immediatePoll();
        });
    },
    [armFastPoll, immediatePoll, prefs, scheduleRender, sessionId]
  );

  // Sync PTY whenever prefs or sessionId change
  useEffect(() => {
    syncGridAndResizePty(false);
  }, [syncGridAndResizePty]);

  // ResizeObserver and layout resize listener
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
        if (resizeInFlightRef.current) return;
        resizeInFlightRef.current = true;
        armFastPoll(350);

        void invokeCommand('resize_terminal', {
          sessionId,
          columns: latest.cols,
          rows: latest.rows,
        })
          .catch(() => {})
          .finally(() => {
            resizeInFlightRef.current = false;
            immediatePoll();
          });
      }, 32);
    };

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => onContainerResize());
      ro.observe(container);
    }

    const unbindDragEnd = onTerminalDividerDragEnd(() => {
      if (resizeTimer !== null) {
        window.clearTimeout(resizeTimer);
        resizeTimer = null;
      }
      syncGridAndResizePty(true);
    });

    const handleWindowResize = () => onContainerResize();
    const handleLayoutResize = () => {
      cachedRectRef.current = null;
      syncGridAndResizePty(true);
    };

    window.addEventListener('resize', handleWindowResize);
    window.addEventListener('kite:layout-resized', handleLayoutResize);

    return () => {
      ro?.disconnect();
      unbindDragEnd();
      window.removeEventListener('resize', handleWindowResize);
      window.removeEventListener('kite:layout-resized', handleLayoutResize);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
    };
  }, [armFastPoll, immediatePoll, prefs, scheduleRender, sessionId, syncGridAndResizePty]);

  // Appearance change subscription
  useEffect(() => {
    const onAppearanceChange = (e: Event) => {
      const customEvent = e as CustomEvent<TerminalAppearancePrefs>;
      if (customEvent.detail) {
        setPrefs(customEvent.detail);
      } else {
        setPrefs(getTerminalAppearancePrefs());
      }
      cachedRectRef.current = null;
    };

    window.addEventListener(TERMINAL_APPEARANCE_CHANGED_EVENT, onAppearanceChange);
    return () => window.removeEventListener(TERMINAL_APPEARANCE_CHANGED_EVENT, onAppearanceChange);
  }, []);

  // Sync isFocused prop to native input focus and internal tracking
  useEffect(() => {
    if (isFocused) {
      inputRef.current?.focus();
    }
  }, [isFocused]);

  useEffect(() => {
    if (isFocused !== undefined) {
      isFocusedRef.current = Boolean(isFocused);
      scheduleRender();
    }
  }, [isFocused, scheduleRender]);

  // Auto-focus on mount or session change
  useEffect(() => {
    if (sessionId) {
      inputRef.current?.focus();
    }
  }, [sessionId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    armFastPoll(1000);

    // Ctrl/Cmd + C / V clipboard shortcuts
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
        return;
      }
    }

    const vtSeq = encodeVtKey(e, {
      kittyFlags: kittyKeyboardFlagsRef.current,
      win32Mode: win32InputModeRef.current,
      applicationCursor: applicationCursorRef.current,
      alternateScreen: alternateScreenRef.current,
      gridRows: gridRowsRef.current,
      onScrollPageUp: () => requestScrollLines(Math.max(1, gridRowsRef.current - 2)),
      onScrollPageDown: () => requestScrollLines(-Math.max(1, gridRowsRef.current - 2)),
    });

    if (vtSeq !== null) {
      e.preventDefault();
      sendInput(vtSeq);
    } else if (e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
      e.preventDefault();
    }
  };

  const handleInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    if (isComposingRef.current) return;
    const value = e.currentTarget.value;
    if (value) {
      sendInput(value);
      e.currentTarget.value = '';
    }
  };

  const handleCompositionStart = () => {
    isComposingRef.current = true;
  };

  const handleCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    isComposingRef.current = false;
    const value = e.currentTarget.value || e.data;
    if (value) {
      sendInput(value);
      e.currentTarget.value = '';
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData('text/plain');
    if (text) {
      e.preventDefault();
      pasteTextToTerminal(text);
    }
  };

  // A click anywhere on the surface (including the canvas, whose default mousedown action moves focus
  // to <body> when it is not preventDefault-ed) must hand focus back to the hidden input so typing keeps working.
  const handleContainerClick = () => {
    inputRef.current?.focus();
  };

  return (
    <div
      ref={containerRef}
      className={`terminal-canvas-surface-container ${className}`}
      onClick={handleContainerClick}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        backgroundColor: '#0a0a0a',
        overflow: 'hidden',
        outline: 'none',
      }}
    >
      <canvas
        ref={canvasRef}
        className="terminal-canvas-surface"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onContextMenu={handleContextMenu}
        onWheel={handleWheel}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          cursor: 'text',
        }}
      />
      <textarea
        ref={inputRef}
        className="terminal-canvas-surface__input"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck="false"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onPaste={handlePaste}
        onFocus={() => {
          isFocusedRef.current = true;
          scheduleRender();
          if (focusReportingRef.current) {
            sendInput('\x1b[I', false);
          }
        }}
        onBlur={() => {
          isFocusedRef.current = false;
          scheduleRender();
          if (focusReportingRef.current) {
            sendInput('\x1b[O', false);
          }
        }}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '1px',
          height: '1px',
          opacity: 0,
          pointerEvents: 'none',
          padding: 0,
          margin: 0,
          border: 'none',
          outline: 'none',
          resize: 'none',
          overflow: 'hidden',
          zIndex: -1,
        }}
      />
    </div>
  );
};
