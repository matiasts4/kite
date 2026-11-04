import { useEffect, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invokeCommand, isTauriEnvironment } from '../../../../lib/ipc';
import { recordTerminalOutput } from '../../../../lib/terminalRegistry';
import { isTerminalDividerDragging } from '../../../../lib/terminalViewport';
import { delayUntilNextPull, shouldScheduleFollowUp } from './outputClock';
import { classifySnapshotApply, commitDirtyRows, syncGridState } from './snapshotApply';
import { setTerminalBenchmarkActive } from './terminalBenchMetrics';
import { visibleScreenText } from './terminalGridText';
import {
  type CellSnapshot,
  type CursorSnapshot,
  type GridState,
  type RenderSnapshot,
  type TerminalMouseMode,
  type TerminalSnapshotPollResponse,
} from './terminalCanvasTypes';
import {
  classifyBinaryPollPayload,
  decodeBinarySnapshotIntoGrid,
  readBinarySnapshotSeq,
} from './binarySnapshotDecoder';

function decodeObservedBytes(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i += 1) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

type SnapshotPollResponse = TerminalSnapshotPollResponse & {
  /** Backend benchmark gate state, mirrored into the frontend collector. */
  benchmarkActive?: boolean;
};

export interface UseTerminalSnapshotPollerOptions {
  sessionId: string;
  workspaceId?: string | null;
  engine?: string;
  matrixRef: React.MutableRefObject<CellSnapshot[][]>;
  cursorRef: React.MutableRefObject<CursorSnapshot>;
  alternateScreenRef: React.MutableRefObject<boolean>;
  applicationCursorRef: React.MutableRefObject<boolean>;
  bracketedPasteRef: React.MutableRefObject<boolean>;
  mouseModeRef: React.MutableRefObject<TerminalMouseMode>;
  sgrMouseRef: React.MutableRefObject<boolean>;
  sgrPixelsMouseRef: React.MutableRefObject<boolean>;
  focusReportingRef: React.MutableRefObject<boolean>;
  win32InputModeRef: React.MutableRefObject<boolean>;
  kittyKeyboardFlagsRef: React.MutableRefObject<number>;
  scrollbackOffsetRef: React.MutableRefObject<number>;
  rowWrappedRef?: React.MutableRefObject<boolean[]>;
  onViewportMetrics?: (metrics: { offset: number; depth: number }) => void;
  onScreenText?: (text: string) => void;
  appliedPtyColsRef: React.MutableRefObject<number>;
  appliedPtyRowsRef: React.MutableRefObject<number>;
  isFocusedRef: React.MutableRefObject<boolean>;
  onTitleChange?: (title: string) => void;
  onProcessExit?: (exitCode: number | null) => void;
  scheduleRender: (dirtyRows?: number[]) => void;
  resizeInFlightRef?: React.MutableRefObject<boolean>;
  lastSeqRef?: React.MutableRefObject<number>;
  hasNotifiedExitRef?: React.MutableRefObject<boolean>;
  preferBinarySnapshot?: boolean;
}

export function useTerminalSnapshotPoller(options: UseTerminalSnapshotPollerOptions) {
  const {
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
    appliedPtyColsRef,
    appliedPtyRowsRef,
    onTitleChange,
    onProcessExit,
    scheduleRender,
    preferBinarySnapshot = true,
  } = options;

  const internalLastSeqRef = useRef<number>(0);
  const lastSeqRef = options.lastSeqRef ?? internalLastSeqRef;
  const internalHasNotifiedExitRef = useRef<boolean>(false);
  const hasNotifiedExitRef = options.hasNotifiedExitRef ?? internalHasNotifiedExitRef;
  const lastTitleRef = useRef<string>('');
  const immediatePollRef = useRef<(() => void) | null>(null);
  const resumePollRef = useRef<(() => void) | null>(null);
  const fullResyncRef = useRef<(() => void) | null>(null);
  const internalResizeInFlightRef = useRef<boolean>(false);
  const resizeInFlightRef = options.resizeInFlightRef ?? internalResizeInFlightRef;
  const packedGridRef = useRef<GridState | null>(null);
  const preferBinarySnapshotRef = useRef(preferBinarySnapshot);
  preferBinarySnapshotRef.current = preferBinarySnapshot;

  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const onProcessExitRef = useRef(onProcessExit);
  onProcessExitRef.current = onProcessExit;
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const onViewportMetricsRef = useRef(options.onViewportMetrics);
  onViewportMetricsRef.current = options.onViewportMetrics;
  const onScreenTextRef = useRef(options.onScreenText);
  onScreenTextRef.current = options.onScreenText;

  const armFastPoll = useCallback((_ms: number) => {
    immediatePollRef.current?.();
  }, []);

  const applySnapshot = useCallback(
    (snapshot: RenderSnapshot) => {
      const plan = classifySnapshotApply(lastSeqRef.current, snapshot.seq, snapshot.full);
      if (plan === 'ignore') return;
      if (plan === 'resync') {
        fullResyncRef.current?.();
        return;
      }
      const previousCursorRow = cursorRef.current.row;
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
      if (rowWrappedRef) {
        if (snapshot.full) {
          const flags = Array.from({ length: snapshot.rows }, () => false);
          for (const row of snapshot.dirtyRows) {
            if (row.rowIdx >= 0 && row.rowIdx < flags.length) flags[row.rowIdx] = Boolean(row.wrapped);
          }
          rowWrappedRef.current = flags;
        } else {
          if (rowWrappedRef.current.length !== snapshot.rows) {
            const next = rowWrappedRef.current.slice(0, snapshot.rows);
            while (next.length < snapshot.rows) next.push(false);
            rowWrappedRef.current = next;
          }
          for (const row of snapshot.dirtyRows) {
            if (row.rowIdx >= 0 && row.rowIdx < rowWrappedRef.current.length) {
              rowWrappedRef.current[row.rowIdx] = Boolean(row.wrapped);
            }
          }
        }
      }
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

      const packedGrid = packedGridRef.current;
      if (
        snapshot.packedDirtyRows !== undefined &&
        packedGrid !== null &&
        packedGrid.rows.length === snapshot.rows
      ) {
        // The packed decoder already mutated the persistent grid's row cells in place,
        // so hand the matrix those exact row arrays instead of copying every cell a
        // second time (S1: steady-state frames allocate no per-cell objects).
        const rows: CellSnapshot[][] = new Array(snapshot.rows);
        for (let row = 0; row < snapshot.rows; row += 1) {
          const cells = packedGrid.rows[row]?.cells;
          if (cells && cells.length > 0) {
            rows[row] = cells;
          } else if (snapshot.full) {
            rows[row] = [];
          } else {
            rows[row] = matrixRef.current[row] ?? [];
          }
        }
        matrixRef.current = rows;
      } else {
        matrixRef.current = commitDirtyRows(
          matrixRef.current,
          snapshot.rows,
          snapshot.dirtyRows,
          Boolean(snapshot.full)
        );
      }
      if (packedGrid) {
        syncGridState(packedGrid, matrixRef.current, snapshot.cols);
      }
      onScreenTextRef.current?.(visibleScreenText(matrixRef.current));
      onViewportMetricsRef.current?.({
        offset: snapshot.scrollbackOffset ?? 0,
        depth: snapshot.scrollbackDepth ?? 0,
      });

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

      if (snapshot.full) {
        scheduleRender();
      } else {
        const rows = snapshot.dirtyRows.map((row) => row.rowIdx);
        rows.push(snapshot.cursor.row);
        if (previousCursorRow !== snapshot.cursor.row) rows.push(previousCursorRow);
        scheduleRender(rows);
      }
    },
    [
      alternateScreenRef,
      applicationCursorRef,
      appliedPtyColsRef,
      appliedPtyRowsRef,
      armFastPoll,
      bracketedPasteRef,
      cursorRef,
      focusReportingRef,
      kittyKeyboardFlagsRef,
      lastSeqRef,
      matrixRef,
      mouseModeRef,
      rowWrappedRef,
      resizeInFlightRef,
      scheduleRender,
      scrollbackOffsetRef,
      sessionId,
      sgrMouseRef,
      sgrPixelsMouseRef,
      win32InputModeRef,
    ]
  );

  const liveRef = useRef(true);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let pendingWake = false;
    let pendingFull = false;
    let gapTimer: number | null = null;
    let lastPullAt = 0;
    let unlisten: (() => void) | null = null;
    const observedDecoder = new TextDecoder('utf-8');

    const clearGap = () => {
      if (gapTimer !== null) {
        window.clearTimeout(gapTimer);
        gapTimer = null;
      }
    };

    const pull = async (immediate: boolean, full: boolean) => {
      if (!active || !liveRef.current) return;
      if (full) pendingFull = true;
      const wait = delayUntilNextPull(lastPullAt, performance.now(), immediate || pendingFull);
      if (wait > 0) {
        pendingWake = true;
        if (gapTimer === null) {
          gapTimer = window.setTimeout(() => {
            gapTimer = null;
            void pull(true, pendingFull);
          }, wait);
        }
        return;
      }
      if (inFlight) {
        pendingWake = true;
        return;
      }
      const wantFull = pendingFull;
      pendingFull = false;
      inFlight = true;
      pendingWake = false;
      lastPullAt = performance.now();
      const sinceSeq = wantFull ? 0 : lastSeqRef.current;
      try {
        if (preferBinarySnapshotRef.current) {
          let binRes: unknown;
          let binFailed = false;
          try {
            binRes = await invokeCommand<unknown>('poll_terminal_snapshot_bin', {
              sessionId,
              sinceSeq,
            });
          } catch {
            binFailed = true;
          }
          if (!binFailed) {
            const payload = classifyBinaryPollPayload(binRes);
            if (payload.kind === 'data') {
              inFlight = false;
              if (!active) return;
              const previousGrid = packedGridRef.current;
              const seqOk = readBinarySnapshotSeq(payload.bytes) >= lastSeqRef.current;
              const decoded = decodeBinarySnapshotIntoGrid(
                payload.bytes,
                seqOk ? previousGrid : null
              );
              if (seqOk) {
                // Seed the persistent grid on the first frame, then reuse it so the
                // decoder mutates existing cell slots instead of allocating new ones.
                packedGridRef.current = decoded.grid;
              }
              if (decoded.snapshot.benchmarkActive !== undefined) {
                setTerminalBenchmarkActive(Boolean(decoded.snapshot.benchmarkActive));
              }
              const observedText = decoded.snapshot.observedText;
              const observedBytesBase64 = decoded.snapshot.observedBytesBase64;
              if (typeof observedText === 'string' && observedText.length > 0) {
                recordTerminalOutput(sessionId, observedText, {
                  workspaceId: workspaceIdRef.current,
                  engine: engineRef.current,
                });
              } else if (
                typeof observedBytesBase64 === 'string' &&
                observedBytesBase64.length > 0
              ) {
                try {
                  const text = observedDecoder.decode(
                    decodeObservedBytes(observedBytesBase64),
                    { stream: true }
                  );
                  if (text) {
                    recordTerminalOutput(sessionId, text, {
                      workspaceId: workspaceIdRef.current,
                      engine: engineRef.current,
                    });
                  }
                } catch {
                  // A bad chunk must not stop the paint poll.
                }
              }
              if (decoded.exited && !hasNotifiedExitRef.current) {
                hasNotifiedExitRef.current = true;
                onProcessExitRef.current?.(decoded.exitCode ?? null);
              }
              applySnapshot(decoded.snapshot);
              void invokeCommand('replenish_terminal_credit', {
                sessionId,
                amount: 1,
              }).catch(() => {});
              if (shouldScheduleFollowUp(pendingWake) && liveRef.current) {
                void pull(pendingFull, pendingFull);
              }
              return;
            }
            if (payload.kind === 'empty') {
              // The daemon has no new dirty rows and paused the channel credit.
              inFlight = false;
              if (shouldScheduleFollowUp(pendingWake) && liveRef.current) {
                void pull(pendingFull, pendingFull);
              }
              return;
            }
          }
          // No binary transport available: fall back to the JSON poll below.
        }

        const res = await invokeCommand<SnapshotPollResponse>('poll_terminal_snapshot', {
          sessionId,
          sinceSeq,
        });
        inFlight = false;
        if (typeof res?.benchmarkActive === 'boolean') {
          setTerminalBenchmarkActive(res.benchmarkActive);
        }
        if (res?.observedBytesBase64) {
          try {
            const text = observedDecoder.decode(decodeObservedBytes(res.observedBytesBase64), {
              stream: true,
            });
            if (text) {
              recordTerminalOutput(sessionId, text, {
                workspaceId: workspaceIdRef.current,
                engine: engineRef.current,
              });
            }
          } catch {
            // A bad chunk must not stop the paint poll.
          }
        }
        if (!active) return;
        if (res?.exited && !hasNotifiedExitRef.current) {
          hasNotifiedExitRef.current = true;
          onProcessExitRef.current?.(res.exitCode ?? null);
        }
        if (res?.kind === 'snapshot') {
          applySnapshot(res.snapshot);
          void invokeCommand('replenish_terminal_credit', { amount: 1 }).catch(() => {});
        }
        if (shouldScheduleFollowUp(pendingWake) && liveRef.current) {
          void pull(pendingFull, pendingFull);
        }
      } catch {
        inFlight = false;
      }
    };

    const triggerImmediatePoll = () => {
      if (!active || !liveRef.current) return;
      clearGap();
      void pull(true, false);
    };

    immediatePollRef.current = triggerImmediatePoll;
    resumePollRef.current = () => {
      if (!active) return;
      clearGap();
      void pull(true, true);
    };
    fullResyncRef.current = () => {
      if (!active) return;
      clearGap();
      void pull(true, true);
    };
    void pull(true, true);

    if (isTauriEnvironment()) {
      void listen<{
        sessionId?: string;
        exited?: boolean;
        exitCode?: number | null;
      }>('terminal://activity', (event) => {
        if (!active || event.payload.sessionId !== sessionId) return;
        if (event.payload.exited) {
          if (!hasNotifiedExitRef.current) {
            hasNotifiedExitRef.current = true;
            onProcessExitRef.current?.(event.payload.exitCode ?? null);
          }
          return;
        }
        if (!liveRef.current) return;
        void pull(false, false);
      }).then((stop) => {
        if (!active) {
          stop();
          return;
        }
        unlisten = stop;
      });
    }

    return () => {
      active = false;
      immediatePollRef.current = null;
      resumePollRef.current = null;
      fullResyncRef.current = null;
      clearGap();
      unlisten?.();
    };
  }, [applySnapshot, hasNotifiedExitRef, lastSeqRef, sessionId]);

  const immediatePoll = useCallback(() => {
    immediatePollRef.current?.();
  }, []);

  const setSurfaceLive = useCallback((live: boolean) => {
    const wasLive = liveRef.current;
    liveRef.current = live;
    if (live && !wasLive) {
      resumePollRef.current?.();
    }
  }, []);

  return {
    immediatePoll,
    armFastPoll,
    applySnapshot,
    setSurfaceLive,
  };
}
