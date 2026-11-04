import React, { forwardRef, useRef, useEffect, useState, useCallback, useImperativeHandle } from 'react';
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
import { collectFindHits, type GridFindHit } from './terminal/canvas/terminalGridText';
import './terminal/canvas/terminalCanvasChrome.css';
import { encodeVtKey, normalizePasteText } from './terminal/canvas/terminalInputKeyEncoder';
import { useTerminalMouseTracking } from './terminal/canvas/useTerminalMouseTracking';
import { useTerminalSnapshotPoller } from './terminal/canvas/useTerminalSnapshotPoller';
import { recordTerminalUserInput } from './terminal/canvas/terminalBenchMetrics';

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
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);
  const [findCount, setFindCount] = useState(0);
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
  const findQueryRef = useRef('');
  const findOpenRef = useRef(false);
  const findInputRef = useRef<HTMLInputElement>(null);
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
    rowWrappedRef.current = [];
    findHitsRef.current = [];
    findQueryRef.current = '';
    findOpenRef.current = false;
    setFindOpen(false);
    setFindQuery('');
    setFindIndex(0);
    setFindCount(0);
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
      if (liveTimerRef.current !== null) {
        window.clearTimeout(liveTimerRef.current);
        liveTimerRef.current = null;
      }
    };
  }, []);

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dirtyRows = paintRowsRef.current;
    paintRowsRef.current = [];
    spareYRef.current = renderCanvasGrid({
      canvas,
      prefs,
      matrix: matrixRef.current,
      cursor: cursorRef.current,
      dirtyRows,
      cursorBlinkOn: cursorBlinkOnRef.current,
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
  }, [prefs]);

  const paintRowsRef = useRef<number[] | null>([]);
  const cursorBlinkOnRef = useRef(true);
  const surfaceLiveRef = useRef(true);

  const scheduleRender = useCallback((rows?: number[]) => {
    if (!rows) {
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
    if (findOpenRef.current && findQueryRef.current.trim()) {
      findHitsRef.current = collectFindHits(
        matrixRef.current,
        rowWrappedRef.current,
        findQueryRef.current,
      );
      const count = findHitsRef.current.length;
      setFindCount((prev) => (prev === count ? prev : count));
      setFindIndex((prev) => {
        const next = count === 0 ? 0 : Math.min(prev, count - 1);
        findIndexRef.current = next;
        return next;
      });
    }
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

  const { immediatePoll, armFastPoll, applySnapshot, setSurfaceLive } = useTerminalSnapshotPoller({
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
    onViewportMetrics,
    onScreenText,
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
    const publish = () => {
      const live = compute();
      if (published === live) return;
      published = live;
      surfaceLiveRef.current = live;
      setSurfaceLive(live);
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
      document.removeEventListener('visibilitychange', publish);
      window.removeEventListener('resize', publish);
      observer?.disconnect();
      surfaceLiveRef.current = false;
      setSurfaceLive(false);
      void invokeCommand('set_terminal_presentation', { sessionId, live: false }).catch(() => {});
    };
  }, [sessionId, setSurfaceLive]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const cursor = cursorRef.current;
      if (!surfaceLiveRef.current) return;
      if (!cursor.visible || cursor.blink === false) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      cursorBlinkOnRef.current = !cursorBlinkOnRef.current;
      scheduleRender([cursor.row]);
    }, 530);
    return () => window.clearInterval(id);
  }, [scheduleRender]);

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
        scheduleRender(selectionRows(start, end));
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
    rowWrappedRef,
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
        void invokeCommand<RenderSnapshot>('scroll_terminal_viewport', {
          sessionId,
          absoluteOffset: target,
        })
          .then((snapshot) => {
            if (snapshot && typeof snapshot.seq === 'number') applySnapshot(snapshot);
            scheduleRender();
          })
          .catch(() => {})
          .finally(() => {
            if (pendingJumpRef.current !== null) flush();
            else jumpInFlightRef.current = false;
          });
      };
      if (!jumpInFlightRef.current) flush();
    },
    [applySnapshot, armFastPoll, scheduleRender, sessionId]
  );

  const applyFindQuery = useCallback(
    (query: string) => {
      findQueryRef.current = query;
      setFindQuery(query);
      if (!query.trim()) {
        findHitsRef.current = [];
        setFindCount(0);
        setFindIndex(0);
        scheduleRender();
        return;
      }
      const local = collectFindHits(matrixRef.current, rowWrappedRef.current, query);
      if (local.length > 0) {
        findHitsRef.current = local;
        setFindCount(local.length);
        setFindIndex(0);
        findIndexRef.current = 0;
        scheduleRender();
        return;
      }
      void invokeCommand<{ hits: Array<{ scrollbackOffset: number; row: number; col: number }> }>(
        'find_terminal_text',
        { sessionId, query, limit: 40 },
      )
        .then(async (res) => {
          const hit = res?.hits?.[0];
          if (!hit || findQueryRef.current !== query) {
            if (findQueryRef.current === query) {
              findHitsRef.current = [];
              setFindCount(0);
              scheduleRender();
            }
            return;
          }
          const snapshot = await invokeCommand<RenderSnapshot>('scroll_terminal_viewport', {
            sessionId,
            absoluteOffset: hit.scrollbackOffset,
          });
          if (findQueryRef.current !== query) return;
          if (snapshot && typeof snapshot.seq === 'number') applySnapshot(snapshot);
          const next = collectFindHits(matrixRef.current, rowWrappedRef.current, query);
          findHitsRef.current = next;
          setFindCount(next.length);
          setFindIndex(0);
          findIndexRef.current = 0;
          scheduleRender();
        })
        .catch(() => {});
    },
    [applySnapshot, scheduleRender, sessionId]
  );

  const stepFind = useCallback(
    (direction: 1 | -1) => {
      const count = findHitsRef.current.length;
      if (count === 0) return;
      const next = (findIndexRef.current + direction + count) % count;
      findIndexRef.current = next;
      setFindIndex(next);
      scheduleRender();
    },
    [scheduleRender]
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

  useEffect(() => {
    if (findOpen) findInputRef.current?.focus();
  }, [findOpen]);

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
      scheduleRender([cursorRef.current.row]);
    }
  }, [isFocused, scheduleRender]);

  // Auto-focus on mount or session change
  useEffect(() => {
    if (sessionId) {
      inputRef.current?.focus();
    }
  }, [sessionId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    recordTerminalUserInput();
    if (e.nativeEvent.isComposing) return;
    armFastPoll(1000);

    // Ctrl/Cmd + C / V clipboard shortcuts
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === 'c') {
        if (e.shiftKey || copySelectionToClipboard()) {
          const start = selectionStartRef.current;
          const end = selectionEndRef.current;
          selectionStartRef.current = null;
          selectionEndRef.current = null;
          scheduleRender(selectionRows(start, end));
          e.preventDefault();
          return;
        }
        if (!e.metaKey) {
          sendInput('\x03');
          e.preventDefault();
          return;
        }
      }
      if (key === 'f') {
        e.preventDefault();
        findOpenRef.current = true;
        setFindOpen(true);
        return;
      }
      if (key === 'v') {
        e.preventDefault();
        if (e.shiftKey && typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
          void navigator.clipboard.readText().then((txt) => {
            if (txt) pasteTextToTerminal(txt);
          });
          return;
        }
        void (async () => {
          const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
          if (clipboard?.read) {
            try {
              const items = await clipboard.read();
              for (const item of items) {
                const imgType = item.types.find((type) => type.toLowerCase().startsWith('image/'));
                if (!imgType) continue;
                const blob = await item.getType(imgType);
                if (onStageClipboardBlobRef.current?.(blob, imgType)) return;
              }
            } catch {
              // Fall through to text. A path already on the clipboard still pastes.
            }
          }
          const readText = clipboard?.readText?.bind(clipboard);
          const text = readText ? await readText().catch(() => '') : '';
          if (text) pasteTextToTerminal(text);
        })();
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
          cursor: 'text',
        }}
      />
      {showScrollbar ? (
        <div
          ref={scrollbarTrackRef}
          className="terminal-canvas-scrollbar"
          onPointerDown={onScrollbarPointerDown}
        >
          <div
            className="terminal-canvas-scrollbar__thumb"
            style={{
              height: `${Math.max(8, Math.round(thumbRatio * 100))}%`,
              top: `${viewport.depth <= 0 ? 0 : ((viewport.depth - viewport.offset) / viewport.depth) * (100 - Math.max(8, Math.round(thumbRatio * 100)))}%`,
            }}
          />
        </div>
      ) : null}
      {findOpen ? (
        <form
          className="terminal-canvas-find"
          onSubmit={(event) => {
            event.preventDefault();
            stepFind(1);
          }}
        >
          <input
            ref={findInputRef}
            aria-label="Buscar en la terminal"
            placeholder="Buscar"
            value={findQuery}
            onChange={(event) => applyFindQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                findOpenRef.current = false;
                findHitsRef.current = [];
                setFindOpen(false);
                setFindCount(0);
                scheduleRender();
                inputRef.current?.focus();
                return;
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                stepFind(event.shiftKey ? -1 : 1);
              }
            }}
          />
          <span className="terminal-canvas-find__count">
            {findCount === 0 ? '0' : `${findIndex + 1}/${findCount}`}
          </span>
          <button type="button" aria-label="Anterior" onClick={() => stepFind(-1)}>
            ↑
          </button>
          <button type="button" aria-label="Siguiente" onClick={() => stepFind(1)}>
            ↓
          </button>
          <button
            type="button"
            aria-label="Cerrar búsqueda"
            onClick={() => {
              findOpenRef.current = false;
              findHitsRef.current = [];
              setFindOpen(false);
              setFindCount(0);
              scheduleRender();
              inputRef.current?.focus();
            }}
          >
            ×
          </button>
        </form>
      ) : null}
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
