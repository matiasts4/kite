/** Minimum gap between terminal frame pulls while output is continuous. */
export const OUTPUT_GAP_MS = 33;

/**
 * How long to wait before the next pull.
 * `0` means pull now. A keystroke or the first pull passes `immediate`.
 */
export function delayUntilNextPull(lastPullAt: number, now: number, immediate: boolean): number {
  if (immediate || lastPullAt <= 0) return 0;
  const elapsed = now - lastPullAt;
  if (elapsed >= OUTPUT_GAP_MS) return 0;
  return OUTPUT_GAP_MS - elapsed;
}

/**
 * After a pull, stop unless a wake arrived while that pull was in flight.
 * A snapshot or a byte chunk is not itself a reason to poll again.
 */
export function shouldScheduleFollowUp(pendingWake: boolean): boolean {
  return pendingWake;
}
