import React, { useRef, useCallback, useEffect } from 'react';
import { invokeCommand } from '../../../../lib/ipc';
import type { TerminalAppearancePrefs } from '../../../../lib/terminalAppearancePrefs';
import {
  isTerminalDividerDragging,
  onTerminalDividerDragEnd,
} from '../../../../lib/terminalViewport';
import { finishPtyResize, planStartupNudge, requestPtyResize } from './ptyResizeGate';
import { measureTerminalCanvasGrid } from './terminalCanvasTypes';

export interface UseTerminalPtyResizeOptions {
  sessionId?: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  cachedRectRef: React.MutableRefObject<DOMRect | null>;
  cellWidthRef: React.MutableRefObject<number>;
  cellHeightRef: React.MutableRefObject<number>;
  baselineOffsetRef: React.MutableRefObject<number>;
  gridColsRef: React.MutableRefObject<number>;
  gridRowsRef: React.MutableRefObject<number>;
  prefs: TerminalAppearancePrefs;
  scheduleRender: (rows?: number[]) => void;
  armFastPoll: (ms: number) => void;
  resumePoll: () => void;
  appliedPtyColsRef: React.MutableRefObject<number>;
  appliedPtyRowsRef: React.MutableRefObject<number>;
  resizeInFlightRef: React.MutableRefObject<boolean>;
  queuedPtyRef: React.MutableRefObject<{ cols: number; rows: number } | null>;
  reconcilePtySizeRef?: React.MutableRefObject<(() => void) | null>;
}

export function useTerminalPtyResize({
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
}: UseTerminalPtyResizeOptions) {
  const startupNudgeArmedRef = useRef(false);
  const startupNudgeTimerRef = useRef<number | null>(null);

  const flushPtyResizeRef = useRef<() => void>(() => {});
  const sendPtyResizeRef = useRef<(cols: number, rows: number, force?: boolean) => void>(() => {});

  flushPtyResizeRef.current = () => {
    const decision = finishPtyResize({
      inFlight: resizeInFlightRef.current,
      appliedCols: appliedPtyColsRef.current,
      appliedRows: appliedPtyRowsRef.current,
      queued: queuedPtyRef.current,
    });
    queuedPtyRef.current = decision.gate.queued;
    appliedPtyColsRef.current = decision.gate.appliedCols;
    appliedPtyRowsRef.current = decision.gate.appliedRows;
    resizeInFlightRef.current = decision.gate.inFlight;
    if (!decision.send) {
      resizeInFlightRef.current = false;
      resumePoll();
      return;
    }
    resizeInFlightRef.current = true;
    armFastPoll(350);
    void invokeCommand('resize_terminal', {
      sessionId,
      columns: decision.send.cols,
      rows: decision.send.rows,
    })
      .catch(() => {})
      .finally(() => {
        flushPtyResizeRef.current();
      });
  };

    if (reconcilePtySizeRef) {
      reconcilePtySizeRef.current = () => {
        sendPtyResizeRef.current(
          appliedPtyColsRef.current,
          appliedPtyRowsRef.current,
          true,
        );
      };
    }

  sendPtyResizeRef.current = (cols: number, rows: number, force = false) => {
    const decision = requestPtyResize(
      {
        inFlight: resizeInFlightRef.current,
        appliedCols: appliedPtyColsRef.current,
        appliedRows: appliedPtyRowsRef.current,
        queued: queuedPtyRef.current,
      },
      cols,
      rows,
      force,
    );
    queuedPtyRef.current = decision.gate.queued;
    appliedPtyColsRef.current = decision.gate.appliedCols;
    appliedPtyRowsRef.current = decision.gate.appliedRows;
    resizeInFlightRef.current = decision.gate.inFlight;
    if (!decision.send) return;
    armFastPoll(350);
    void invokeCommand('resize_terminal', {
      sessionId,
      columns: decision.send.cols,
      rows: decision.send.rows,
    })
      .catch(() => {})
      .finally(() => {
        flushPtyResizeRef.current();
      });
  };

  const armStartupNudge = (cols: number, rows: number) => {
    if (startupNudgeArmedRef.current || isTerminalDividerDragging()) return;
    const planned = planStartupNudge(cols, rows);
    if (!planned) return;
    startupNudgeArmedRef.current = true;
    if (startupNudgeTimerRef.current !== null) {
      window.clearTimeout(startupNudgeTimerRef.current);
    }
    const fire = () => {
      startupNudgeTimerRef.current = null;
      if (!containerRef.current) return;
      if (isTerminalDividerDragging()) return;
      if (resizeInFlightRef.current) {
        startupNudgeTimerRef.current = window.setTimeout(fire, 50);
        return;
      }
      const latest = measureTerminalCanvasGrid(containerRef.current, prefs);
      const again = planStartupNudge(latest.cols, latest.rows);
      if (!again) return;
      sendPtyResizeRef.current(again.nudge.cols, again.nudge.rows, true);
      sendPtyResizeRef.current(again.restore.cols, again.restore.rows, true);
    };
    startupNudgeTimerRef.current = window.setTimeout(fire, 350);
  };

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

      sendPtyResizeRef.current(metrics.cols, metrics.rows, forceImmediate);
      armStartupNudge(metrics.cols, metrics.rows);
    },
    [prefs, scheduleRender, sessionId, containerRef, cachedRectRef, cellWidthRef, cellHeightRef, baselineOffsetRef, gridColsRef, gridRowsRef]
  );

  // Sync PTY whenever prefs change
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
        if (resizeTimer !== null) {
          window.clearTimeout(resizeTimer);
          resizeTimer = null;
        }
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
        sendPtyResizeRef.current(latest.cols, latest.rows, false);
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
  }, [prefs, scheduleRender, syncGridAndResizePty, containerRef, cachedRectRef, cellWidthRef, cellHeightRef, baselineOffsetRef, gridColsRef, gridRowsRef]);

  // Fonts ready listener
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts?.ready) return;
    let cancelled = false;
    void fonts.ready.then(() => {
      if (cancelled) return;
      syncGridAndResizePty(false);
    });
    return () => {
      cancelled = true;
    };
  }, [syncGridAndResizePty]);

  return {
    resizeInFlightRef,
    queuedPtyRef,
    appliedPtyColsRef,
    appliedPtyRowsRef,
    flushPtyResizeRef,
    sendPtyResizeRef,
    reconcilePtySizeRef,
    syncGridAndResizePty,
  };
}
