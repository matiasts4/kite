import { describe, expect, it } from 'vitest';
import { cursorPaintPhase } from './cursorPaintPhase';

describe('cursorPaintPhase', () => {
  it('keeps a steady caret visible when the blink phase is off', () => {
    expect(cursorPaintPhase(false, false)).toBe(true);
    expect(cursorPaintPhase(false, true)).toBe(true);
  });

  it('follows the phase only while blinking is enabled', () => {
    expect(cursorPaintPhase(true, false)).toBe(false);
    expect(cursorPaintPhase(true, true)).toBe(true);
  });
});
