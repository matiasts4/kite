import { useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import { followLiveEdge } from './contract';

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

  return (id: string): boolean => {
    if (seededIdsRef.current.has(id) || enterIdsRef.current.has(id)) {
      return enterIdsRef.current.has(id);
    }
    enterIdsRef.current.add(id);
    return true;
  };
}

export function useTranscriptLiveEdge(
  transcriptRef: RefObject<HTMLElement | null>,
  threadId: string | null,
  atLiveEdgeRef: MutableRefObject<boolean>,
) {
  const observedRef = useRef<{
    threadId: string | null;
    column: HTMLElement;
    observer: ResizeObserver;
  } | null>(null);

  // Runs after every commit on purpose: the transcript only mounts once the first
  // message exists, so a thread-id dependency alone never attached to a new chat.
  useLayoutEffect(() => {
    const scroller = transcriptRef.current;
    const found = scroller?.querySelector('.chat-transcript__column') ?? null;
    const column = found instanceof HTMLElement ? found : null;
    const current = observedRef.current;
    if (current && current.column === column && current.threadId === threadId) return;

    current?.observer.disconnect();
    observedRef.current = null;
    atLiveEdgeRef.current = true;
    if (!scroller || !column) return;
    scroller.scrollTop = scroller.scrollHeight;
    if (typeof ResizeObserver === 'undefined') return;
    let prev = column.getBoundingClientRect().height;
    const observer = new ResizeObserver(() => {
      const next = column.getBoundingClientRect().height;
      const delta = next - prev;
      prev = next;
      scroller.scrollTop = followLiveEdge(scroller.scrollTop, delta, atLiveEdgeRef.current);
    });
    observer.observe(column);
    observedRef.current = { threadId, column, observer };
  });

  useLayoutEffect(
    () => () => {
      observedRef.current?.observer.disconnect();
      observedRef.current = null;
    },
    [],
  );
}
