import { describe, expect, it } from 'vitest';
import { delayUntilNextPull, OUTPUT_GAP_MS, shouldScheduleFollowUp } from './outputClock';

describe('terminal output clock', () => {
  it('pulls immediately for a key and for the first wake', () => {
    expect(delayUntilNextPull(1_000, 1_010, true)).toBe(0);
    expect(delayUntilNextPull(0, 50, false)).toBe(0);
  });

  it('collapses a burst onto the 33 ms gap', () => {
    expect(delayUntilNextPull(1_000, 1_010, false)).toBe(OUTPUT_GAP_MS - 10);
    expect(delayUntilNextPull(1_000, 1_033, false)).toBe(0);
    expect(delayUntilNextPull(1_000, 1_080, false)).toBe(0);
  });

  it('stops after a frame when no later wake is waiting', () => {
    expect(shouldScheduleFollowUp(false)).toBe(false);
  });

  it('pulls again when a wake arrived during the in-flight pull', () => {
    expect(shouldScheduleFollowUp(true)).toBe(true);
  });
});
