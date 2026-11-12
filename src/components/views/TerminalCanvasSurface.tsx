import React, { forwardRef, useRef, useEffect, useState, useCallback, useImperativeHandle } from 'react';
import { invokeCommand } from '../../lib/ipc';
import {
  type TerminalAppearancePrefs,
  getTerminalAppearancePrefs,
  TERMINAL_APPEARANCE_CHANGED_EVENT,
} from '../../lib/terminalAppearancePrefs';
import {
  type SelectionPoint,
  selectionRows,
  type HoveredLinkSpan,
  type TerminalMouseMode,
  type CellSnapshot,
  type CursorSnapshot,
  type RenderSnapshot,
  measureTerminalCanvasGrid,
  type TerminalCanvasSurfaceProps,
  type TerminalSurfaceHandle,
} from './terminal/canvas/terminalCanvasTypes';
import { renderCanvasGrid } from './terminal/canvas/canvasGridRenderer';
import { cursorPaintPhase } from './terminal/canvas/cursorPaintPhase';
import { type GridFindHit } from './terminal/canvas/terminalGridText';
import { normalizePasteText } from './terminal/canvas/terminalInputKeyEncoder';
import './terminal/canvas/terminalCanvasChrome.css';
import { useTerminalMouseTracking } from './terminal/canvas/useTerminalMouseTracking';
import { useTerminalSnapshotPoller } from './terminal/canvas/useTerminalSnapshotPoller';
import { useTerminalKeyInput } from './terminal/canvas/useTerminalKeyInput';
import { useTerminalFindController } from './terminal/canvas/useTerminalFindController';
import { useTerminalPtyResize } from './terminal/canvas/useTerminalPtyResize';
import { TerminalFindBar } from './terminal/canvas/TerminalFindBar';
import { TerminalCanvasScrollbar } from './terminal/canvas/TerminalCanvasScrollbar';
import { classifyBinaryPollPayload, decodeBinarySnapshot } from './terminal/canvas/binarySnapshotDecoder';
import { OUTPUT_GAP_HIDDEN_HEARTBEAT_MS, type OutputPace } from './terminal/canvas/outputClock';

export { measureTerminalCanvasGrid };
export type { TerminalCanvasSurfaceProps };

export const TerminalCanvasSurface = forwardRef<TerminalSurfaceHandle, TerminalCanvasSurfaceProps>(function TerminalCanvasSurface({
  sessionId,
  workspaceId,
  engine,
  isFocused,
  className = '',
  onTitleChange,
  onProcessExit,
  onStageClipboardBlob,
}, ref) {
  const [prefs, setPrefs] = useState<TerminalAppearancePrefs>(() =>
    getTerminalAppearancePrefs()
  );
  const [viewport, setViewport] = useState({ offset: 0, depth: 0, alt: false });
  const [liveText, setLiveText] = useState('');

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
  const rowWrappedRef = useRef<boolean[]>([]);
  const findHitsRef = useRef<GridFindHit[]>([]);
  const findIndexRef = useRef(0);
  const findOpenRef = useRef(false);
  const onViewportMetricsFindRef = useRef<((depth: number) => void) | null>(null);
  const onStageClipboardBlobRef = useRef(onStageClipboardBlob);
  onStageClipboardBlobRef.current = onStageClipboardBlob;
  const scrollbarTrackRef = useRef<HTMLDivElement>(null);
  const jumpInFlightRef = useRef(false);
  const pendingJumpRef = useRef<number | null>(null);
  const liveTimerRef = useRef<number | null>(null);
  const pendingLiveRef = useRef('');
  const viewportDepthRef = useRef(0);
  const buttonsDownRef = useRef<number>(0);
  const lastMouseReportRef = useRef<{ col: number; row: number; buttons: number } | null>(null);
  const lastSeqRef = useRef<number>(0);
  const hasNotifiedExitRef = useRef<boolean>(false);

  const appliedPtyColsRef = useRef<number>(0);
  const appliedPtyRowsRef = useRef<number>(0);
  const resizeInFlightRef = useRef<boolean>(false);
  const queuedPtyRef = useRef<{ cols: number; rows: number } | null>(null);
  const reconcilePtySizeRef = useRef<(() => void) | null>(null);
  const paintRetryRef = useRef(0);
  const startupRepaintArmedRef = useRef(false);
  const hasFullPaintRef = useRef(false);
  const startupNudgeArmedRef = useRef(false);
  const startupNudgeTimerRef = useRef<number | null>(null);
  const scrollInFlightRef = useRef<boolean>(false);
  const pendingScrollLinesRef = useRef<number>(0);
  const scrollFlushTimerRef = useRef<number | null>(null);

  const selectionAnchorRef = useRef<SelectionPoint | null>(null);
  const selectionStartRef = useRef<SelectionPoint | null>(null);
  const selectionEndRef = useRef<SelectionPoint | null>(null);
  const hoveredLinkRef = useRef<HoveredLinkSpan | null>(null);
  const rowCacheRef = useRef<Map<number, CellSnapshot[]>>(new Map());
  const syncSelectionOnScrollRef = useRef<(() => void) | null>(null);

  const matrixRef = useRef<CellSnapshot[][]>([]);
  const cursorRef = useRef<CursorSnapshot>({
    col: 0,
    row: 0,
    visible: true,
    shape: 'block',
    blink: false,
  });

  // Reset tracking when sessionId changes
  useEffect(() => {
    lastSeqRef.current = 0;
    matrixRef.current = [];
    rowCacheRef.current.clear();
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
    queuedPtyRef.current = null;
    paintRetryRef.current = 0;
    startupRepaintArmedRef.current = false;
    hasFullPaintRef.current = false;
    startupNudgeArmedRef.current = false;
    if (startupNudgeTimerRef.current !== null) {
      window.clearTimeout(startupNudgeTimerRef.current);
      startupNudgeTimerRef.current = null;
    }
    cursorBlinkOnRef.current = true;
    paintRowsRef.current = null;
    cursorRef.current = {
      col: 0,
      row: 0,
      visible: true,
      shape: 'block',
      blink: false,
    };
    selectionAnchorRef.current = null;
    selectionStartRef.current = null;
    selectionEndRef.current = null;
    hoveredLinkRef.current = null;
    rowWrappedRef.current = [];
    setViewport({ offset: 0, depth: 0, alt: false });
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
      if (startupNudgeTimerRef.current !== null) {
        window.clearTimeout(startupNudgeTimerRef.current);
        startupNudgeTimerRef.current = null;
      }
      if (liveTimerRef.current !== null) {
        window.clearTimeout(liveTimerRef.current);
        liveTimerRef.current = null;
      }
    };
  }, []);

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) {
      // The restored pane has no box yet. Keep the pending rows and try again
      // so the first snapshot is not discarded before layout commits.
      if (paintRetryRef.current < 8) {
        paintRetryRef.current += 1;
        rafIdRef.current = window.requestAnimationFrame(() => {
          rafIdRef.current = null;
          renderCanvas();
        });
      }
      return;
    }
    paintRetryRef.current = 0;

    const dirtyRows = hasFullPaintRef.current ? paintRowsRef.current : null;
    paintRowsRef.current = [];
    spareYRef.current = renderCanvasGrid({
      canvas,
      prefs,
      matrix: matrixRef.current,
      cursor: cursorRef.current,
      dirtyRows,
      cursorBlinkOn: cursorPaintPhase(prefs.cursorBlink, cursorBlinkOnRef.current),
      selection: {
        start: selectionStartRef.current,
        end: selectionEndRef.current,
      },
      hoveredLink: hoveredLinkRef.current,
      findHits: findHitsRef.current,
      activeFind: findIndexRef.current,
      isFocused: isFocusedRef.current,
      scrollbackOffset: scrollbackOffsetRef.current,
      cellW: cellWidthRef.current,
      cellH: cellHeightRef.current,
      baseline: baselineOffsetRef.current,
      gridRows: gridRowsRef.current,
      gridCols: gridColsRef.current,
    });
    hasFullPaintRef.current = true;

    // One extra full frame after the first real paint. Restore often commits
    // the final pane box a frame after the first snapshot.
    if (!startupRepaintArmedRef.current) {
      startupRepaintArmedRef.current = true;
      rafIdRef.current = window.requestAnimationFrame(() => {
        rafIdRef.current = null;
        paintRowsRef.current = null;
        renderCanvas();
      });
    }
  }, [prefs]);

  const paintRowsRef = useRef<number[] | null>([]);
  const cursorBlinkOnRef = useRef(true);
  const surfaceLiveRef = useRef(true);

  const scheduleRender = useCallback((rows?: number[]) => {
    paintRetryRef.current = 0;
    if (!rows || rows.length === 0) {
      paintRowsRef.current = null;
    } else if (paintRowsRef.current) {
      for (const row of rows) {
        if (!paintRowsRef.current.includes(row)) paintRowsRef.current.push(row);
      }
    }
    if (rafIdRef.current !== null) return;
    rafIdRef.current = window.requestAnimationFrame(() => {
      rafIdRef.current = null;
      renderCanvas();
    });
  }, [renderCanvas]);

  const onViewportMetrics = useCallback((metrics: { offset: number; depth: number }) => {
    viewportDepthRef.current = metrics.depth;
    const alt = alternateScreenRef.current;
    setViewport((prev) => {
      if (prev.offset === metrics.offset && prev.depth === metrics.depth && prev.alt === alt) return prev;
      return { offset: metrics.offset, depth: metrics.depth, alt };
    });
    onViewportMetricsFindRef.current?.(metrics.depth);
  }, []);

  const onScreenText = useCallback((text: string) => {
    pendingLiveRef.current = text;
    if (liveTimerRef.current !== null) return;
    liveTimerRef.current = window.setTimeout(() => {
      liveTimerRef.current = null;
      const next = pendingLiveRef.current;
      setLiveText((prev) => (prev === next ? prev : next));
    }, 250);
  }, []);

  const { immediatePoll, resumePoll, armFastPoll, applySnapshot, setSurfaceLive, setOutputPace } = useTerminalSnapshotPoller({
    sessionId,
    workspaceId,
    engine,
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
    rowWrappedRef,
    rowCacheRef,
    onScrollbackChange: () => syncSelectionOnScrollRef.current?.(),
    onViewportMetrics,
    onScreenText,
    appliedPtyColsRef,
    appliedPtyRowsRef,
    isFocusedRef,
    onTitleChange,
    onProcessExit,
    scheduleRender,
    resizeInFlightRef,
    reconcilePtySizeRef,
    lastSeqRef,
    hasNotifiedExitRef,
  });

  useEffect(() => {
    const el = containerRef.current;
    let seenLayout = false;
    let published: boolean | null = null;
    const compute = () => {
      if (!el || !el.isConnected) return true;
      if (el.closest('[aria-hidden="true"]')) return false;
      if (document.visibilityState === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width >= 2 && rect.height >= 2) {
        seenLayout = true;
        return true;
      }
      return !seenLayout;
    };
    let heartbeat: number | null = null;
    const stopHeartbeat = () => {
      if (heartbeat !== null) {
        window.clearInterval(heartbeat);
        heartbeat = null;
      }
    };
    const publish = () => {
      const hidden = document.visibilityState === 'hidden';
      const live = compute();
      const pace: OutputPace = hidden ? 'hidden' : isFocusedRef.current ? 'focused' : 'visible';
      setOutputPace(pace);
      // A hidden window stops paint. Credit still gets a slow refill so a
      // streaming agent is not stuck on an empty snapshot budget.
      if (hidden && heartbeat === null) {
        heartbeat = window.setInterval(() => {
          void invokeCommand('replenish_terminal_credit', { sessionId, amount: 1 }).catch(() => {});
        }, OUTPUT_GAP_HIDDEN_HEARTBEAT_MS);
      } else if (!hidden) {
        stopHeartbeat();
      }
      if (published === live) return;
      published = live;
      surfaceLiveRef.current = live;
      setSurfaceLive(live);
      if (live) scheduleRender();
      void invokeCommand('set_terminal_presentation', { sessionId, live }).catch(() => {});
    };
    publish();
    document.addEventListener('visibilitychange', publish);
    window.addEventListener('resize', publish);
    const observer =
      typeof IntersectionObserver !== 'undefined' && el
        ? new IntersectionObserver(() => publish())
        : null;
    if (observer && el) observer.observe(el);
    return () => {
      stopHeartbeat();
      document.removeEventListener('visibilitychange', publish);
      window.removeEventListener('resize', publish);
      observer?.disconnect();
      surfaceLiveRef.current = false;
      setSurfaceLive(false);
      void invokeCommand('set_terminal_presentation', { sessionId, live: false }).catch(() => {});
    };
  }, [scheduleRender, sessionId, setOutputPace, setSurfaceLive]);

  useEffect(() => {
    if (!prefs.cursorBlink) {
      if (!cursorBlinkOnRef.current) {
        cursorBlinkOnRef.current = true;
        scheduleRender([cursorRef.current.row]);
      }
      return;
    }
    const id = window.setInterval(() => {
      const cursor = cursorRef.current;
      if (!surfaceLiveRef.current) return;
      if (!cursor.visible) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      cursorBlinkOnRef.current = !cursorBlinkOnRef.current;
      scheduleRender([cursor.row]);
    }, 530);
    return () => window.clearInterval(id);
  }, [prefs.cursorBlink, scheduleRender]);

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
        const start = selectionStartRef.current;
        const end = selectionEndRef.current;
        selectionStartRef.current = null;
        selectionEndRef.current = null;
        scheduleRender(
          selectionRows(start, end, scrollbackOffsetRef.current, gridRowsRef.current),
        );
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

  const pullViewport = useCallback(
    async (args: { deltaLines?: number; absoluteOffset?: number }) => {
      try {
        const bin = await invokeCommand<unknown>('scroll_terminal_viewport_bin', {
          sessionId,
          ...args,
        });
        const payload = classifyBinaryPollPayload(bin);
        if (payload.kind === 'data') {
          const decoded = decodeBinarySnapshot(payload.bytes);
          if (decoded.snapshot && typeof decoded.snapshot.seq === 'number') {
            applySnapshot(decoded.snapshot);
          }
          scheduleRender();
          void invokeCommand('replenish_terminal_credit', { sessionId, amount: 1 }).catch(() => {});
          return;
        }
        // Empty means the viewport did not move. A second JSON scroll would move it twice.
        if (payload.kind === 'empty') {
          scheduleRender();
          return;
        }
      } catch {
        // Older hosts have no binary scroll command.
      }
      const snapshot = await invokeCommand<RenderSnapshot>('scroll_terminal_viewport', {
        sessionId,
        ...args,
      });
      if (snapshot && typeof snapshot.seq === 'number') applySnapshot(snapshot);
      scheduleRender();
    },
    [applySnapshot, scheduleRender, sessionId],
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
        void pullViewport({ deltaLines: delta })
          .catch(() => {})
          .finally(() => {
            if (pendingScrollLinesRef.current !== 0) flush();
            else scrollInFlightRef.current = false;
          });
      };
      if (scrollInFlightRef.current) return;
      flush();
    },
    [pullViewport]
  );

  const setPointerCursor = useCallback((pointer: boolean) => {
    if (canvasRef.current) {
      canvasRef.current.style.cursor = pointer ? 'pointer' : 'default';
    }
  }, []);

  const scrollPaceTimerRef = useRef<number | null>(null);
  const noteWheelPace = useCallback(() => {
    setOutputPace('focused');
    if (scrollPaceTimerRef.current !== null) window.clearTimeout(scrollPaceTimerRef.current);
    scrollPaceTimerRef.current = window.setTimeout(() => {
      scrollPaceTimerRef.current = null;
      if (document.visibilityState === 'hidden') setOutputPace('hidden');
      else if (!isFocusedRef.current) setOutputPace('visible');
    }, 220);
  }, [setOutputPace]);

  const {
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleMouseLeave,
    handleContextMenu,
    handleWheel,
    copySelectionToClipboard,
    syncSelectionOnScroll,
  } = useTerminalMouseTracking({
    canvasRef,
    cachedRectRef,
    gridColsRef,
    gridRowsRef,
    cellWidthRef,
    cellHeightRef,
    spareYRef,
    matrixRef,
    rowWrappedRef,
    rowCacheRef,
    scrollbackOffsetRef,
    sessionId,
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
    onWheelActivity: noteWheelPace,
    setPointerCursor,
    onFocusInput: () => inputRef.current?.focus(),
    armFastPoll,
  });
  syncSelectionOnScrollRef.current = syncSelectionOnScroll;

  const {
    findOpen,
    setFindOpen,
    findQuery,
    findIndex,
    findCount,
    findInputRef,
    applyFindQuery,
    stepFind,
    closeFind,
    onViewportMetricsFind,
  } = useTerminalFindController({
    sessionId,
    matrixRef,
    rowWrappedRef,
    pullViewport,
    scheduleRender,
    inputRef,
    findHitsRef,
    findIndexRef,
    findOpenRef,
  });
  onViewportMetricsFindRef.current = onViewportMetricsFind;

  const { syncGridAndResizePty } = useTerminalPtyResize({
    sessionId,
    containerRef,
    cachedRectRef,
    cellWidthRef,
    cellHeightRef,
    baselineOffsetRef,
    gridColsRef,
    gridRowsRef,
    prefs,
    scheduleRender,
    armFastPoll,
    resumePoll,
    appliedPtyColsRef,
    appliedPtyRowsRef,
    resizeInFlightRef,
    queuedPtyRef,
    reconcilePtySizeRef,
  });

  const jumpToOffset = useCallback(
    (offset: number) => {
      const next = Math.max(0, Math.round(offset));
      pendingJumpRef.current = next;
      const flush = () => {
        const target = pendingJumpRef.current;
        if (target === null) {
          jumpInFlightRef.current = false;
          return;
        }
        pendingJumpRef.current = null;
        jumpInFlightRef.current = true;
        armFastPoll(250);
        void pullViewport({ absoluteOffset: target })
          .catch(() => {})
          .finally(() => {
            if (pendingJumpRef.current !== null) flush();
            else jumpInFlightRef.current = false;
          });
      };
      if (!jumpInFlightRef.current) flush();
    },
    [armFastPoll, pullViewport]
  );

  useImperativeHandle(
    ref,
    () => ({
      clear: () => {
        void invokeCommand('clear_terminal_vt', { sessionId }).finally(() => {
          immediatePoll();
          inputRef.current?.focus();
        });
      },
      focus: () => {
        inputRef.current?.focus();
      },
      fit: () => {
        syncGridAndResizePty(true);
      },
    }),
    [immediatePoll, sessionId, syncGridAndResizePty]
  );

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
      if (document.visibilityState !== 'hidden') {
        setOutputPace(isFocused ? 'focused' : 'visible');
      }
      scheduleRender([cursorRef.current.row]);
    }
  }, [isFocused, scheduleRender, setOutputPace]);

  // Auto-focus on mount or session change
  useEffect(() => {
    if (sessionId) {
      inputRef.current?.focus();
    }
  }, [sessionId]);

  const {
    handleKeyDown,
    handleInput,
    handleCompositionStart,
    handleCompositionEnd,
    handlePaste,
  } = useTerminalKeyInput({
    sessionId,
    sendInput,
    pasteTextToTerminal,
    armFastPoll,
    copySelectionToClipboard,
    selectionStartRef,
    selectionEndRef,
    scrollbackOffsetRef,
    gridRowsRef,
    scheduleRender,
    findOpenRef,
    setFindOpen,
    onStageClipboardBlobRef,
    kittyKeyboardFlagsRef,
    win32InputModeRef,
    applicationCursorRef,
    alternateScreenRef,
    requestScrollLines,
  });

  const onScrollbarPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (viewport.depth <= 0) return;
    const track = scrollbarTrackRef.current;
    if (!track) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = track.getBoundingClientRect();
    const thumb = track.querySelector('.terminal-canvas-scrollbar__thumb') as HTMLElement | null;
    const thumbH = thumb?.offsetHeight ?? 18;
    const travel = Math.max(1, rect.height - thumbH);
    const fromThumb = (event.target as HTMLElement).classList.contains('terminal-canvas-scrollbar__thumb');
    const originY = event.clientY;
    const originTop = fromThumb
      ? Math.min(travel, Math.max(0, originY - rect.top - thumbH / 2))
      : Math.min(travel, Math.max(0, originY - rect.top - thumbH / 2));
    const offsetForTop = (top: number) => {
      const ratio = Math.min(1, Math.max(0, top / travel));
      return Math.round((1 - ratio) * viewportDepthRef.current);
    };
    jumpToOffset(offsetForTop(originTop));
    const move = (ev: PointerEvent) => {
      const top = Math.min(travel, Math.max(0, originTop + (ev.clientY - originY)));
      jumpToOffset(offsetForTop(top));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const rowsForThumb = Math.max(1, gridRowsRef.current);
  const thumbRatio = viewport.depth > 0 ? rowsForThumb / (rowsForThumb + viewport.depth) : 1;
  const showScrollbar = viewport.depth > 0 && !viewport.alt;

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
          cursor: 'default',
        }}
      />
      <TerminalCanvasScrollbar
        show={showScrollbar}
        scrollbarTrackRef={scrollbarTrackRef}
        onPointerDown={onScrollbarPointerDown}
        thumbRatio={thumbRatio}
        depth={viewport.depth}
        offset={viewport.offset}
      />
      <TerminalFindBar
        isOpen={findOpen}
        query={findQuery}
        count={findCount}
        index={findIndex}
        findInputRef={findInputRef}
        onChangeQuery={applyFindQuery}
        onStepFind={stepFind}
        onClose={closeFind}
      />
      <div className="terminal-canvas-live" aria-live="polite" aria-atomic="true">
        {liveText}
      </div>
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
          scheduleRender([cursorRef.current.row]);
          if (focusReportingRef.current) {
            sendInput('\x1b[I', false);
          }
        }}
        onBlur={() => {
          isFocusedRef.current = false;
          scheduleRender([cursorRef.current.row]);
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
});

TerminalCanvasSurface.displayName = 'TerminalCanvasSurface';
