import { useEffect, useRef, useState } from 'react';

export const SMOOTH_STREAM_MIN_FRAME_MS = 15;
export const SMOOTH_STREAM_BYPASS_CHARS = 6_000;

export interface SmoothStreamingOptions {
  /** Reveal initial text smoothly from the start when a brand-new live row mounts. */
  animateInitial?: boolean;
}

function clampSurrogateBoundary(text: string, index: number): number {
  let next = Math.min(text.length, Math.max(0, index));
  if (next > 0 && next < text.length) {
    const prevCode = text.charCodeAt(next - 1);
    if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
      next = Math.min(text.length, next + 1);
    }
  }
  return next;
}

function computeInitialRevealLength(targetText: string, animateInitial: boolean): number {
  if (!animateInitial || targetText.length === 0) {
    return targetText.length;
  }
  const firstVisibleIdx = targetText.search(/\S/);
  if (firstVisibleIdx < 0) {
    return targetText.length;
  }
  return clampSurrogateBoundary(targetText, firstVisibleIdx + 2);
}

/** Computes the next character index when smoothly revealing buffered streaming text. */
export function computeNextRevealLength(currentLen: number, targetText: string): number {
  const total = targetText.length;
  if (currentLen >= total) return total;
  const backlog = total - currentLen;
  const step =
    backlog <= 6
      ? Math.max(1, Math.ceil(backlog / 3))
      : backlog <= 32
        ? Math.max(2, Math.ceil(backlog * 0.14))
        : backlog <= 140
          ? Math.max(5, Math.ceil(backlog * 0.13))
          : Math.max(18, Math.ceil(backlog * 0.2));
  return clampSurrogateBoundary(targetText, currentLen + step);
}

/**
 * Smoothly paces newly appended streaming prose across animation frames so bursty
 * backend/CLI chunks glide in continuously instead of jumping in large blocks.
 *
 * Seeded/existing text (unless `animateInitial` is enabled for newly mounted live rows),
 * non-streaming items, reduced-motion mode, blocks exceeding `SMOOTH_STREAM_BYPASS_CHARS`,
 * and non-monotonic replacements always render at 100% synchronously.
 */
export function useSmoothStreamingText(
  targetText: string,
  active: boolean,
  options?: SmoothStreamingOptions,
): string {
  const animateInitial = Boolean(options?.animateInitial);
  const startSmoothOnMount =
    animateInitial && active && targetText.length <= SMOOTH_STREAM_BYPASS_CHARS;

  const [revealedLen, setRevealedLen] = useState<number>(() =>
    computeInitialRevealLength(targetText, startSmoothOnMount),
  );
  const prevTargetRef = useRef<string>(targetText);
  const targetTextRef = useRef<string>(targetText);
  const revealedLenRef = useRef<number>(revealedLen);
  const frameIdRef = useRef<number | null>(null);
  const lastCommitTimeRef = useRef<number | null>(null);

  // Detect non-monotonic resets (e.g., waiting-narration replacement or sanitization rewrite)
  // synchronously during render so we never show stale truncated prefixes.
  const prevTarget = prevTargetRef.current;
  const isMonotonicGrowth =
    targetText.length >= prevTarget.length && targetText.startsWith(prevTarget);
  const bypassSmoothReveal =
    !active || !isMonotonicGrowth || targetText.length > SMOOTH_STREAM_BYPASS_CHARS;
  if (bypassSmoothReveal) {
    revealedLenRef.current = targetText.length;
  }
  const bypassRef = useRef<boolean>(bypassSmoothReveal);
  bypassRef.current = bypassSmoothReveal;
  targetTextRef.current = targetText;
  prevTargetRef.current = targetText;

  useEffect(() => {
    return () => {
      if (frameIdRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frameIdRef.current);
        frameIdRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (bypassSmoothReveal || typeof requestAnimationFrame !== 'function') {
      if (frameIdRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frameIdRef.current);
        frameIdRef.current = null;
      }
      lastCommitTimeRef.current = null;
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

    if (frameIdRef.current !== null) {
      return;
    }

    const step = (now: number) => {
      if (bypassRef.current) {
        frameIdRef.current = null;
        lastCommitTimeRef.current = null;
        return;
      }
      const latestTarget = targetTextRef.current;
      if (revealedLenRef.current >= latestTarget.length) {
        frameIdRef.current = null;
        lastCommitTimeRef.current = null;
        return;
      }
      const elapsed =
        lastCommitTimeRef.current !== null
          ? now - lastCommitTimeRef.current
          : SMOOTH_STREAM_MIN_FRAME_MS;
      // Throttle 120Hz+ displays to ~60fps while allowing synchronous unit-test flushes
      // (elapsed < 4ms) and standard 60Hz vsyncs (~16.6ms) to advance on every frame.
      if (elapsed >= 4 && elapsed < SMOOTH_STREAM_MIN_FRAME_MS) {
        frameIdRef.current = requestAnimationFrame(step);
        return;
      }
      lastCommitTimeRef.current = now;
      const next = computeNextRevealLength(revealedLenRef.current, latestTarget);
      revealedLenRef.current = next;
      setRevealedLen(next);
      if (next < latestTarget.length) {
        frameIdRef.current = requestAnimationFrame(step);
      } else {
        frameIdRef.current = null;
        lastCommitTimeRef.current = null;
      }
    };

    frameIdRef.current = requestAnimationFrame(step);
  }, [bypassSmoothReveal, targetText]);

  if (bypassSmoothReveal) {
    return targetText;
  }
  const effectiveLen = Math.min(targetText.length, revealedLen);
  return effectiveLen >= targetText.length ? targetText : targetText.slice(0, effectiveLen);
}
