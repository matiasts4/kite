/** Focused pane, or a wheel gesture: one frame per display refresh. */
export const OUTPUT_GAP_FOCUSED_MS = 16;

/** Visible pane that does not have focus. About 15 fps, enough for a TUI to keep moving. */
export const OUTPUT_GAP_VISIBLE_MS = 66;

/**
 * Hidden or minimized window. No canvas paint. This is only the credit heartbeat
 * so a streaming agent does not block on an empty snapshot budget.
 * About 6 fps, inside the 4–8 fps band.
 */
export const OUTPUT_GAP_HIDDEN_HEARTBEAT_MS = 166;

/** Focused gap. Kept for callers that still import the old name. */
export const OUTPUT_GAP_MS = OUTPUT_GAP_FOCUSED_MS;

export type OutputPace = 'focused' | 'visible' | 'hidden';

export function outputGapMs(pace: OutputPace): number {
  if (pace === 'hidden') return OUTPUT_GAP_HIDDEN_HEARTBEAT_MS;
  if (pace === 'visible') return OUTPUT_GAP_VISIBLE_MS;
  return OUTPUT_GAP_FOCUSED_MS;
}

/**
 * How long to wait before the next pull.
 * `0` means pull now. A keystroke or the first pull passes `immediate`.
 * `gapMs` is the pace for this pane. Idle still stops: a gap is not a timer.
 */
export function delayUntilNextPull(
  lastPullAt: number,
  now: number,
  immediate: boolean,
  gapMs: number = OUTPUT_GAP_FOCUSED_MS,
): number {
  if (immediate || lastPullAt <= 0) return 0;
  const gap = gapMs > 0 ? gapMs : OUTPUT_GAP_FOCUSED_MS;
  const elapsed = now - lastPullAt;
  if (elapsed >= gap) return 0;
  return gap - elapsed;
}

/**
 * After a pull, stop unless a wake arrived while that pull was in flight.
 * A snapshot or a byte chunk is not itself a reason to poll again.
 */
export function shouldScheduleFollowUp(pendingWake: boolean): boolean {
  return pendingWake;
}
