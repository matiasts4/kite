import { useEffect, useRef, useCallback } from 'react';
import { invokeCommand } from '../../../../lib/ipc';
import { isTerminalDividerDragging } from '../../../../lib/terminalViewport';
import {
  type CellSnapshot,
  type CursorSnapshot,
  type RenderSnapshot,
  type TerminalMouseMode,
  type TerminalSnapshotPollResponse,
} from './terminalCanvasTypes';

export interface UseTerminalSnapshotPollerOptions {
  sessionId: string;
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
  appliedPtyColsRef: React.MutableRefObject<number>;
  appliedPtyRowsRef: React.MutableRefObject<number>;
  isFocusedRef: React.MutableRefObject<boolean>;
  onTitleChange?: (title: string) => void;
  onProcessExit?: (exitCode: number | null) => void;
  scheduleRender: () => void;
  resizeInFlightRef?: React.MutableRefObject<boolean>;
  lastSeqRef?: React.MutableRefObject<number>;
  hasNotifiedExitRef?: React.MutableRefObject<boolean>;
}

export function useTerminalSnapshotPoller(options: UseTerminalSnapshotPollerOptions) {
  const {
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
  } = options;

  const internalLastSeqRef = useRef<number>(0);
  const lastSeqRef = options.lastSeqRef ?? internalLastSeqRef;
  const fastPollUntilRef = useRef<number>(0);
  const internalHasNotifiedExitRef = useRef<boolean>(false);
  const hasNotifiedExitRef = options.hasNotifiedExitRef ?? internalHasNotifiedExitRef;
  const lastTitleRef = useRef<string>('');
  const immediatePollRef = useRef<(() => void) | null>(null);
  const internalResizeInFlightRef = useRef<boolean>(false);
  const resizeInFlightRef = options.resizeInFlightRef ?? internalResizeInFlightRef;

  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const onProcessExitRef = useRef(onProcessExit);
  onProcessExitRef.current = onProcessExit;

  const armFastPoll = useCallback((ms: number) => {
    fastPollUntilRef.current = Math.max(fastPollUntilRef.current, performance.now() + ms);
  }, []);

  const applySnapshot = useCallback(
    (snapshot: RenderSnapshot) => {
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
      resizeInFlightRef,
      scheduleRender,
      scrollbackOffsetRef,
      sessionId,
      sgrMouseRef,
      sgrPixelsMouseRef,
      win32InputModeRef,
    ]
  );

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

        let nextDelay = 80;
        const hidden = typeof document !== 'undefined' && document.hidden;

        if (res) {
          if (res.exited && !hasNotifiedExitRef.current) {
            hasNotifiedExitRef.current = true;
            onProcessExitRef.current?.(res.exitCode ?? null);
          }

          if (res.kind === 'snapshot') {
            applySnapshot(res.snapshot);
            nextDelay = 6;
          } else if (hidden) {
            nextDelay = 500;
          } else if (performance.now() < fastPollUntilRef.current) {
            nextDelay = 8;
          } else if (alternateScreenRef.current) {
            nextDelay = 16;
          } else if (isFocusedRef.current) {
            nextDelay = 60;
          } else {
            nextDelay = 80;
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
  }, [alternateScreenRef, applySnapshot, hasNotifiedExitRef, isFocusedRef, lastSeqRef, sessionId]);

  const immediatePoll = useCallback(() => {
    immediatePollRef.current?.();
  }, []);

  return {
    immediatePoll,
    armFastPoll,
    fastPollUntilRef,
    applySnapshot,
  };
}
