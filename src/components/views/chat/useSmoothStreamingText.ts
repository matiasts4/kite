import { useEffect, useRef, useState } from 'react';

/** Computes the next character index when smoothly revealing buffered streaming text. */
export function computeNextRevealLength(currentLen: number, targetText: string): number {
  const total = targetText.length;
  if (currentLen >= total) return total;
  const backlog = total - currentLen;
  const step =
    backlog <= 16 ? Math.max(2, Math.ceil(backlog / 3)) : Math.max(5, Math.ceil(backlog * 0.22));
  let next = Math.min(total, currentLen + step);
  if (next < total) {
    const prevCode = targetText.charCodeAt(next - 1);
    if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
      next = Math.min(total, next + 1);
    }
  }
  return next;
}

/**
 * Smoothly paces newly appended streaming prose across animation frames so bursty
 * backend/CLI chunks glide in continuously instead of jumping in large blocks.
 *
 * Initial mount text, non-streaming items, reduced-motion mode, and non-monotonic
 * replacements always render at 100% synchronously.
 */
export function useSmoothStreamingText(targetText: string, active: boolean): string {
  const [revealedLen, setRevealedLen] = useState<number>(() => targetText.length);
  const prevTargetRef = useRef<string>(targetText);
  const revealedLenRef = useRef<number>(revealedLen);

  // Detect non-monotonic resets (e.g., waiting-narration replacement or sanitization rewrite)
  // synchronously during render so we never show stale truncated prefixes.
  const prevTarget = prevTargetRef.current;
  const isMonotonicGrowth =
    targetText.length >= prevTarget.length && targetText.startsWith(prevTarget);
  if (!active || !isMonotonicGrowth) {
    revealedLenRef.current = targetText.length;
  }
  prevTargetRef.current = targetText;

  useEffect(() => {
    if (!active || !isMonotonicGrowth || typeof requestAnimationFrame !== 'function') {
      revealedLenRef.current = targetText.length;
      setRevealedLen((prev) => (prev === targetText.length ? prev : targetText.length));
      return;
    }

    if (revealedLenRef.current >= targetText.length) {
      if (revealedLen !== targetText.length) {
        setRevealedLen(targetText.length);
      }
      return;
    }

    let frameId: number | null = null;
    const step = () => {
      const next = computeNextRevealLength(revealedLenRef.current, targetText);
      revealedLenRef.current = next;
      setRevealedLen(next);
      if (next < targetText.length) {
        frameId = requestAnimationFrame(step);
      } else {
        frameId = null;
      }
    };

    frameId = requestAnimationFrame(step);
    return () => {
      if (frameId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frameId);
      }
    };
  }, [active, isMonotonicGrowth, targetText]);

  if (!active || !isMonotonicGrowth) {
    return targetText;
  }
  const effectiveLen = Math.min(targetText.length, revealedLen);
  return effectiveLen >= targetText.length ? targetText : targetText.slice(0, effectiveLen);
}
