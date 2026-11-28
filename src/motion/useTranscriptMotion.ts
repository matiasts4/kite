import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type MutableRefObject,
  type RefObject,
  type UIEvent,
} from 'react';
import { LIVE_EDGE_THRESHOLD_PX, isAtLiveEdge } from './contract';

/**
 * Tracks which transcript rows appeared after their thread mounted.
 *
 * The returned predicate answers "is this row new and should animate in?".
 * Rows already present when the thread mounted stay at rest; rows that arrive
 * later report `true` once and keep reporting `true` while they stay mounted,
 * so a re-render never restarts their entrance.
 */
export function useTranscriptMotion(threadId: string | null, itemIds: string[]) {
  const seededThreadRef = useRef<string | null>(null);
  const seededIdsRef = useRef<Set<string>>(new Set());
  const enterIdsRef = useRef<Set<string>>(new Set());

  if (seededThreadRef.current !== threadId) {
    seededThreadRef.current = threadId;
    seededIdsRef.current = new Set(itemIds);
    enterIdsRef.current = new Set();
  }

  return useCallback((id: string): boolean => {
    if (seededIdsRef.current.has(id) || enterIdsRef.current.has(id)) {
      return enterIdsRef.current.has(id);
    }
    enterIdsRef.current.add(id);
    return true;
  }, []);
}

export interface TranscriptScrollKeys {
  contentKey: string;
  followTrigger: string;
}

export interface TranscriptScrollItemLike {
  id: string;
  kind?: string;
  text?: string | null;
  detail?: string | null;
  status?: string | null;
  streaming?: boolean;
  internalDispatch?: boolean;
}

/** Computes lightweight scroll signature keys for a transcript item array. */
export function buildTranscriptScrollKeys(
  items: readonly TranscriptScrollItemLike[],
  extra = '',
): TranscriptScrollKeys {
  let totalChars = 0;
  let activeCount = 0;
  let lastUserId = '';
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item) continue;
    totalChars += (item.text?.length ?? 0) + (item.detail?.length ?? 0);
    if (
      item.streaming ||
      item.status === 'running' ||
      item.status === 'inProgress' ||
      item.status === 'pending'
    ) {
      activeCount += 1;
    }
    if (item.kind === 'user' && !item.internalDispatch) {
      lastUserId = item.id;
    }
  }
  const last = items[items.length - 1];
  return {
    contentKey: `${items.length}:${totalChars}:${activeCount}:${last?.id ?? ''}:${last?.status ?? ''}:${extra}`,
    followTrigger: lastUserId,
  };
}

export interface UseTranscriptLiveEdgeOptions {
  /** Opaque value changing whenever rendered transcript content or status updates. */
  contentKey?: unknown;
  /** Changes when a new user/voice turn starts on the current thread, snapping back to bottom. */
  followTrigger?: unknown;
  /** Selector for the inner content column (defaults to '.chat-transcript__column'). */
  columnSelector?: string;
  /** Maximum distance from bottom treated as pinned (defaults to LIVE_EDGE_THRESHOLD_PX). */
  edgeThresholdPx?: number;
  /** Minimum overflow required before reporting paused state (defaults to 0). */
  overflowPauseMinPx?: number;
  /** Called whenever scroll-away pause state changes. */
  onPauseChange?: (paused: boolean) => void;
}

export interface TranscriptLiveEdgeResult {
  handleScroll: (e: UIEvent<HTMLElement>) => void;
  scrollToBottom: () => void;
  /** Synchronously re-pins the transcript when an adjacent panel (e.g., composer) resizes before paint. */
  syncLiveEdge: () => void;
}

function hasActiveSelectionIn(scroller: HTMLElement, pointerSelecting: boolean): boolean {
  if (pointerSelecting) return true;
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  return Boolean((anchor && scroller.contains(anchor)) || (focus && scroller.contains(focus)));
}

export function useTranscriptLiveEdge(
  transcriptRef: RefObject<HTMLElement | null>,
  threadId: string | null,
  atLiveEdgeRef: MutableRefObject<boolean>,
  options: UseTranscriptLiveEdgeOptions = {},
): TranscriptLiveEdgeResult {
  const {
    contentKey,
    followTrigger,
    columnSelector = '.chat-transcript__column',
    edgeThresholdPx = LIVE_EDGE_THRESHOLD_PX,
    overflowPauseMinPx = 0,
    onPauseChange,
  } = options;

  const observedRef = useRef<{
    threadId: string | null;
    scroller: HTMLElement;
    column: HTMLElement;
    observer: ResizeObserver;
  } | null>(null);
  const pointerSelectingRef = useRef(false);
  const hadSelectionInScrollerRef = useRef(false);
  const isAdjustingScrollRef = useRef(false);
  const expectedScrollTopRef = useRef<number | null>(null);
  const lastPinnedScrollHeightRef = useRef<number | null>(null);
  const lastPinnedClientHeightRef = useRef<number | null>(null);
  const adjustFrameRef = useRef<number | null>(null);
  const prevFollowRef = useRef<{ threadId: string | null; trigger: unknown }>({
    threadId,
    trigger: followTrigger,
  });
  const onPauseChangeRef = useRef(onPauseChange);
  onPauseChangeRef.current = onPauseChange;
  const thresholdRef = useRef(edgeThresholdPx);
  thresholdRef.current = edgeThresholdPx;
  const overflowMinRef = useRef(overflowPauseMinPx);
  overflowMinRef.current = overflowPauseMinPx;

  const clearProgrammaticFlag = useCallback(() => {
    if (adjustFrameRef.current !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(adjustFrameRef.current);
      adjustFrameRef.current = null;
    }
    if (typeof requestAnimationFrame === 'function') {
      adjustFrameRef.current = requestAnimationFrame(() => {
        adjustFrameRef.current = null;
        isAdjustingScrollRef.current = false;
        expectedScrollTopRef.current = null;
      });
    } else {
      isAdjustingScrollRef.current = false;
      expectedScrollTopRef.current = null;
    }
  }, []);

  const writeScrollBottom = useCallback(
    (scroller: HTMLElement) => {
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const needsScroll =
        scroller.clientHeight > 0
          ? Math.abs(scroller.scrollTop - maxScroll) > 1
          : scroller.scrollTop !== scroller.scrollHeight;
      if (!needsScroll) {
        lastPinnedScrollHeightRef.current = scroller.scrollHeight;
        lastPinnedClientHeightRef.current = scroller.clientHeight;
        return;
      }
      isAdjustingScrollRef.current = true;
      lastPinnedScrollHeightRef.current = scroller.scrollHeight;
      lastPinnedClientHeightRef.current = scroller.clientHeight;
      scroller.scrollTop = scroller.scrollHeight;
      expectedScrollTopRef.current = scroller.scrollTop;
      clearProgrammaticFlag();
    },
    [clearProgrammaticFlag],
  );

  const pinIfAtEdge = useCallback(() => {
    const scroller = transcriptRef.current;
    if (!scroller || !atLiveEdgeRef.current) return;
    if (hasActiveSelectionIn(scroller, pointerSelectingRef.current)) {
      if (hasActiveSelectionIn(scroller, false)) {
        hadSelectionInScrollerRef.current = true;
      }
      return;
    }
    writeScrollBottom(scroller);
  }, [transcriptRef, atLiveEdgeRef, writeScrollBottom]);

  const scrollToBottom = useCallback(() => {
    atLiveEdgeRef.current = true;
    onPauseChangeRef.current?.(false);
    const scroller = transcriptRef.current;
    if (scroller) {
      writeScrollBottom(scroller);
    }
  }, [transcriptRef, atLiveEdgeRef, writeScrollBottom]);

  const handleScroll = useCallback(
    (e: UIEvent<HTMLElement>) => {
      const el = e.currentTarget;
      // Ignore asynchronous scroll notifications caused by our own programmatic pin,
      // even if new content arrived before the scroll event flushed.
      if (
        isAdjustingScrollRef.current &&
        expectedScrollTopRef.current !== null &&
        Math.abs(el.scrollTop - expectedScrollTopRef.current) <= 2
      ) {
        isAdjustingScrollRef.current = false;
        expectedScrollTopRef.current = null;
        if (
          atLiveEdgeRef.current &&
          el.scrollHeight !== lastPinnedScrollHeightRef.current &&
          !hasActiveSelectionIn(el, pointerSelectingRef.current)
        ) {
          writeScrollBottom(el);
        }
        return;
      }

      isAdjustingScrollRef.current = false;
      expectedScrollTopRef.current = null;
      const overflows = el.scrollHeight - el.clientHeight > overflowMinRef.current;
      const nearBottom = isAtLiveEdge(
        el.scrollHeight,
        el.scrollTop,
        el.clientHeight,
        thresholdRef.current,
      );
      atLiveEdgeRef.current = nearBottom;
      onPauseChangeRef.current?.(overflows && !nearBottom);
    },
    [atLiveEdgeRef, writeScrollBottom],
  );

  // Runs after every commit on purpose: the transcript only mounts once the first
  // message exists, so a thread-id dependency alone never attached to a new chat.
  useLayoutEffect(() => {
    const scroller = transcriptRef.current;
    if (
      scroller?.closest(
        '.mode-layer:not(.mode-layer--visible), [aria-hidden="true"], [style*="display: none"], [style*="display:none"], [hidden]',
      )
    ) {
      return;
    }
    const current = observedRef.current;
    const column =
      current &&
      current.scroller === scroller &&
      current.column &&
      current.column.isConnected
        ? current.column
        : (() => {
            const found =
              columnSelector === ':self'
                ? scroller
                : (scroller?.querySelector(columnSelector) ?? null);
            return found instanceof HTMLElement ? found : null;
          })();
    if (
      current &&
      current.scroller === scroller &&
      current.column === column &&
      current.threadId === threadId
    ) {
      if (
        atLiveEdgeRef.current &&
        scroller &&
        lastPinnedClientHeightRef.current !== null &&
        scroller.clientHeight !== lastPinnedClientHeightRef.current
      ) {
        pinIfAtEdge();
      }
      return;
    }

    current?.observer.disconnect();
    observedRef.current = null;
    atLiveEdgeRef.current = true;
    onPauseChangeRef.current?.(false);
    if (!scroller || !column) return;
    writeScrollBottom(scroller);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      pinIfAtEdge();
    });
    observer.observe(column);
    if (column !== scroller) {
      observer.observe(scroller);
    }
    observedRef.current = { threadId, scroller, column, observer };
  });

  // Snap back to bottom when a new user/voice turn starts on the current thread,
  // and keep the bottom pinned whenever rendered transcript content updates.
  useLayoutEffect(() => {
    const prev = prevFollowRef.current;
    const sameThread = prev.threadId === threadId;
    const triggerChanged =
      followTrigger !== undefined && sameThread && prev.trigger !== followTrigger;
    prevFollowRef.current = { threadId, trigger: followTrigger };

    if (triggerChanged) {
      atLiveEdgeRef.current = true;
      onPauseChangeRef.current?.(false);
    }
    pinIfAtEdge();
  }, [threadId, contentKey, followTrigger, atLiveEdgeRef, pinIfAtEdge]);

  const pinIfAtEdgeRef = useRef(pinIfAtEdge);
  pinIfAtEdgeRef.current = pinIfAtEdge;
  const attachedListenersRef = useRef<{ scroller: HTMLElement; cleanup: () => void } | null>(null);

  useEffect(() => {
    pointerSelectingRef.current = false;
    hadSelectionInScrollerRef.current = false;
    lastPinnedScrollHeightRef.current = null;
    lastPinnedClientHeightRef.current = null;
  }, [threadId]);

  // Attach listeners whenever the ref's element mounts/changes (e.g., draft -> active thread).
  useEffect(() => {
    const scroller = transcriptRef.current;
    const current = attachedListenersRef.current;
    if ((current?.scroller ?? null) === scroller) return;
    if (current) {
      current.cleanup();
      attachedListenersRef.current = null;
    }
    if (!scroller) return;

    const onPointerDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      pointerSelectingRef.current = true;
    };
    const onPointerEnd = () => {
      if (!pointerSelectingRef.current) return;
      pointerSelectingRef.current = false;
      if (hasActiveSelectionIn(scroller, false)) {
        hadSelectionInScrollerRef.current = true;
        return;
      }
      hadSelectionInScrollerRef.current = false;
      pinIfAtEdgeRef.current();
    };
    const onSelectionChange = () => {
      if (hasActiveSelectionIn(scroller, false)) {
        hadSelectionInScrollerRef.current = true;
        return;
      }
      if (!hadSelectionInScrollerRef.current) return;
      hadSelectionInScrollerRef.current = false;
      if (pointerSelectingRef.current) return;
      pinIfAtEdgeRef.current();
    };

    scroller.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
    document.addEventListener('selectionchange', onSelectionChange);
    attachedListenersRef.current = {
      scroller,
      cleanup: () => {
        pointerSelectingRef.current = false;
        hadSelectionInScrollerRef.current = false;
        scroller.removeEventListener('pointerdown', onPointerDown);
        window.removeEventListener('pointerup', onPointerEnd);
        window.removeEventListener('pointercancel', onPointerEnd);
        document.removeEventListener('selectionchange', onSelectionChange);
      },
    };
  });

  useEffect(() => {
    return () => {
      attachedListenersRef.current?.cleanup();
      attachedListenersRef.current = null;
    };
  }, []);

  useLayoutEffect(
    () => () => {
      if (adjustFrameRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(adjustFrameRef.current);
        adjustFrameRef.current = null;
      }
      observedRef.current?.observer.disconnect();
      observedRef.current = null;
    },
    [],
  );

  return { handleScroll, scrollToBottom, syncLiveEdge: pinIfAtEdge };
}
