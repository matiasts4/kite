import { describe, expect, it } from 'vitest';
import {
  delayUntilNextPull,
  OUTPUT_GAP_FOCUSED_MS,
  OUTPUT_GAP_HIDDEN_HEARTBEAT_MS,
  OUTPUT_GAP_VISIBLE_MS,
  outputGapMs,
  shouldScheduleFollowUp,
} from './outputClock';

describe('terminal output clock', () => {
  it('pulls immediately for a key and for the first wake', () => {
    expect(delayUntilNextPull(1_000, 1_010, true)).toBe(0);
    expect(delayUntilNextPull(0, 50, false)).toBe(0);
  });

  it('collapses a focused burst onto one display frame', () => {
    expect(delayUntilNextPull(1_000, 1_010, false, OUTPUT_GAP_FOCUSED_MS)).toBe(6);
    expect(delayUntilNextPull(1_000, 1_016, false, OUTPUT_GAP_FOCUSED_MS)).toBe(0);
    expect(delayUntilNextPull(1_000, 1_040, false)).toBe(0);
  });

  it('slows a visible unfocused pane and keeps a hidden heartbeat', () => {
    expect(outputGapMs('focused')).toBe(OUTPUT_GAP_FOCUSED_MS);
    expect(outputGapMs('visible')).toBe(OUTPUT_GAP_VISIBLE_MS);
    expect(outputGapMs('hidden')).toBe(OUTPUT_GAP_HIDDEN_HEARTBEAT_MS);
    expect(delayUntilNextPull(1_000, 1_020, false, outputGapMs('visible'))).toBe(46);
    expect(delayUntilNextPull(1_000, 1_100, false, outputGapMs('hidden'))).toBe(66);
  });

  it('stops after a frame when no later wake is waiting', () => {
    expect(shouldScheduleFollowUp(false)).toBe(false);
  });

  it('pulls again when a wake arrived during the in-flight pull', () => {
    expect(shouldScheduleFollowUp(true)).toBe(true);
  });
});
