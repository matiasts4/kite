import { useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import { followLiveEdge } from './contract';

export function useTranscriptMotion(threadId: string | null, itemIds: string[]) {
  const seededThreadRef = useRef<string | null>(null);
  const seededIdsRef = useRef<Set<string>>(new Set());
  const enterIdsRef = useRef<Set<string>>(new Set());

  if (seededThreadRef.current !== threadId) {
    seededThreadRef.current = threadId;
    seededIdsRef.current = new Set(itemIds);
    enterIdsRef.current = new Set();
  }

  return (id: string) => {
    if (seededIdsRef.current.has(id) || enterIdsRef.current.has(id)) {
      return enterIdsRef.current.has(id) ? 'motion-row-in' : '';
    }
    enterIdsRef.current.add(id);
    return 'motion-row-in';
  };
}

export function useTranscriptLiveEdge(
  transcriptRef: RefObject<HTMLElement | null>,
  threadId: string | null,
  atLiveEdgeRef: MutableRefObject<boolean>,
) {
  useLayoutEffect(() => {
    atLiveEdgeRef.current = true;
    const scroller = transcriptRef.current;
    if (!scroller) return;
    const column = scroller.querySelector('.chat-transcript__column');
    if (!(column instanceof HTMLElement)) return;
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
    return () => observer.disconnect();
  }, [threadId, transcriptRef, atLiveEdgeRef]);
}
